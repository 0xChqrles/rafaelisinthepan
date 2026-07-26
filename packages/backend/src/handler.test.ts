// CONTRACT (issue #2 acceptance criteria): the handler resolves the day's puzzle for a
// requested lang, returns it in the front's `Puzzle` shape, answers a missing puzzle
// with a clean JSON 404 (never a 500), sends CORS headers, and exposes day metadata.

import { gunzipSync } from 'node:zlib';
import { describe, it, expect, vi } from 'vitest';
import { type Puzzle, encodeResult } from '@whippin/shared';
import { createHandler, type HandlerDeps } from './handler';
import { renderCardPng } from './ogCard';
import { LAMBDA_MAX_RESPONSE_BYTES, envelopeBytes, type FnUrlEvent } from './respond';
import type { PuzzleStore } from './store';

// Spy on the card rasterizer (real PNG bytes are opaque to a lang assertion); a stub PNG
// lets us assert the /og route forwards the token's lang into the renderer.
vi.mock('./ogCard', async () => {
  const actual = await vi.importActual<typeof import('./ogCard')>('./ogCard');
  return { ...actual, renderCardPng: vi.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47])) };
});

// A minimal but schema-valid puzzle, keyed by the date the fixed clock resolves to.
const PUZZLE: Puzzle = {
  lang: 'fr',
  words: ['la', 'forêt', 'ancienne'],
  holes: [
    {
      pos: 1,
      secret: { word: 'forêt', slug: 'foret' },
      start: { word: 'bois', slug: 'bois' },
      start_rank: 87,
    },
  ],
  ranks: {
    foret: {
      foret: { word: 'forêt', rank: 0 },
      bois: { word: 'bois', rank: 87 },
    },
  },
};

// 2026-06-29 10:00 EDT (14:00 UTC) -> active date "2026-06-29".
const FIXED_NOW = new Date('2026-06-29T14:00:00Z');
const ACTIVE_DATE = '2026-06-29';
const PAST_30 = '2026-05-30'; // 30 days back — archive-eligible past day
const NEXT_DAY = '2026-06-30'; // active +1: within the future clock-skew window
const DAY_AFTER_NEXT = '2026-07-01'; // active +2: future, still locked
const ORIGIN = 'https://whippin.example';

// The store has a French puzzle for the active day, a far-past day, and both the +1 and
// +2 days — so the handler's future guard (not store emptiness) is what rejects +2.
const PUBLISHED_FR = new Set([ACTIVE_DATE, PAST_30, NEXT_DAY, DAY_AFTER_NEXT]);

function fakeStore(): PuzzleStore {
  return {
    async getPuzzle(date, lang) {
      return PUBLISHED_FR.has(date) && lang === 'fr' ? PUZZLE : null;
    },
  };
}

function makeHandler(overrides: Partial<HandlerDeps> = {}) {
  return createHandler({
    store: fakeStore(),
    now: () => FIXED_NOW,
    allowedOrigin: ORIGIN,
    ...overrides,
  });
}

function event(opts: {
  method?: string;
  path?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
}): FnUrlEvent {
  return {
    rawPath: opts.path ?? '/',
    queryStringParameters: opts.query ?? null,
    requestContext: { http: { method: opts.method ?? 'GET' } },
    headers: opts.headers,
  };
}

// A puzzle whose PLAIN response envelope exceeds the runtime cap — the shape that took the
// 2026-07-26 French puzzle down (6.5 MB of #104 alias keys, answered as a bare 502). It is
// BUILT rather than checked in so it can never drift below the constant it exists to cross;
// the "no Accept-Encoding" case below is what proves it still does.
function oversizedPuzzle(): Puzzle {
  const foret: Record<string, { word: string; rank: number }> = {
    foret: { word: 'forêt', rank: 0 },
    bois: { word: 'bois', rank: 87 },
  };
  // 130k alias keys ≈ a 6.8 MB body / 7.9 MB envelope — comfortably past the cap, and the
  // same order as the real puzzle that broke (100k lands just UNDER it, so the margin here
  // is deliberate rather than incidental).
  for (let i = 0; i < 130_000; i += 1) {
    foret[`voisin${i}`] = { word: `voisiné${i}`, rank: i + 1 };
  }
  return { ...PUZZLE, ranks: { foret } };
}

function oversizedHandler() {
  const puzzle = oversizedPuzzle();
  return makeHandler({
    store: { async getPuzzle(date, lang) { return date === ACTIVE_DATE && lang === 'fr' ? puzzle : null; } },
  });
}

const PUZZLE_QUERY = { lang: 'fr', date: ACTIVE_DATE };

describe('puzzle endpoint — date-addressed (GET /?lang=&date=)', () => {
  it('returns the requested day\'s puzzle for the requested lang, unchanged', async () => {
    const res = await makeHandler()(event({ query: { lang: 'fr', date: ACTIVE_DATE } }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toMatch(/application\/json/);
    expect(JSON.parse(res.body)).toEqual(PUZZLE);
  });

  it('sets CORS + a long CDN / short browser Cache-Control on a hit', async () => {
    const res = await makeHandler()(event({ query: { lang: 'fr', date: ACTIVE_DATE } }));
    expect(res.headers['Access-Control-Allow-Origin']).toBe(ORIGIN);
    // CDN holds the (date, lang) entry until a republish invalidates it; browsers
    // revalidate after minutes so a corrected puzzle shows on a normal reload.
    expect(res.headers['Cache-Control']).toMatch(/s-maxage=\d{6,}/);
    expect(res.headers['Cache-Control']).toMatch(/max-age=300/);
  });

  it('requires `date` — missing or malformed is a 400 protocol violation', async () => {
    const missing = await makeHandler()(event({ query: { lang: 'fr' } }));
    expect(missing.statusCode).toBe(400);
    expect(JSON.parse(missing.body).error).toBe('bad_request');

    for (const bad of ['tomorrow', '2026-13-40', '20260629']) {
      const res = await makeHandler()(event({ query: { lang: 'fr', date: bad } }));
      expect(res.statusCode).toBe(400);
    }
  });

  it('serves any PAST day (the archive is date-addressed): a published day 30 days back is a 200', async () => {
    const res = await makeHandler()(event({ query: { lang: 'fr', date: PAST_30 } }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(PUZZLE);
  });

  it('an unpublished past day -> clean 404 not_found with the short negative TTL', async () => {
    const res = await makeHandler()(event({ query: { lang: 'fr', date: '2026-01-01' } }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('not_found');
    expect(JSON.parse(res.body).date).toBe('2026-01-01');
    expect(res.headers['Cache-Control']).toMatch(/max-age=60\b/);
  });

  it('active day +1 (published) -> 200: clock-skew tolerance around the flip is intact', async () => {
    const res = await makeHandler()(event({ query: { lang: 'fr', date: NEXT_DAY } }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(PUZZLE);
  });

  it('active day +2 (published) -> 404: the future stays locked even when the store has it', async () => {
    const res = await makeHandler()(event({ query: { lang: 'fr', date: DAY_AFTER_NEXT } }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('not_found');
    // The rejection carries the SERVER's active day (the future guard fired before the store).
    expect(JSON.parse(res.body).date).toBe(ACTIVE_DATE);
  });

  it('missing puzzle -> clean JSON 404, never 500', async () => {
    const res = await makeHandler()(event({ query: { lang: 'en', date: ACTIVE_DATE } }));
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('not_found');
    expect(body).toMatchObject({ date: ACTIVE_DATE, lang: 'en' });
    expect(res.headers['Access-Control-Allow-Origin']).toBe(ORIGIN);
  });

  it('missing lang -> 400 bad_request', async () => {
    const res = await makeHandler()(event({}));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('bad_request');
  });

  it('malformed lang -> 400 bad_request', async () => {
    const res = await makeHandler()(event({ query: { lang: 'EN' } }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('bad_request');
  });

  it('a store failure surfaces as a JSON 500, not an unhandled throw', async () => {
    const handler = createHandler({
      store: {
        async getPuzzle() {
          throw new Error('s3 boom');
        },
      },
      now: () => FIXED_NOW,
      allowedOrigin: ORIGIN,
    });
    const res = await handler(event({ query: { lang: 'fr', date: ACTIVE_DATE } }));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toBe('internal_error');
  });
});

// CONTRACT: a puzzle is megabytes of rank maps, and the Lambda runtime refuses a response
// envelope over LAMBDA_MAX_RESPONSE_BYTES with a 413 the caller only ever sees as a 502.
// Compression is what keeps a real puzzle answerable; these pin the negotiation.
describe('puzzle response compression — staying under the runtime envelope cap', () => {
  it('serves an oversized puzzle as gzip when the client accepts it', async () => {
    const res = await oversizedHandler()(
      event({ query: PUZZLE_QUERY, headers: { 'accept-encoding': 'br, gzip, deflate' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Encoding']).toBe('gzip');
    expect(res.isBase64Encoded).toBe(true);
    // The point of the exercise: what the runtime will post back now fits.
    expect(envelopeBytes(res)).toBeLessThan(LAMBDA_MAX_RESPONSE_BYTES);
  });

  it('the compressed body decodes back to the exact puzzle', async () => {
    const res = await oversizedHandler()(
      event({ query: PUZZLE_QUERY, headers: { 'accept-encoding': 'gzip' } }),
    );
    const decoded = JSON.parse(gunzipSync(Buffer.from(res.body, 'base64')).toString('utf8'));
    expect(decoded).toEqual(oversizedPuzzle());
  });

  it('an oversized puzzle a client cannot accept gzipped is a NAMED 500, not a silent 502', async () => {
    // No Accept-Encoding: nothing can shrink the payload, so the handler must own the
    // failure. That this fires at all is also what proves the fixture is genuinely over
    // the cap — the guard has no other trigger.
    const res = await oversizedHandler()(event({ query: PUZZLE_QUERY }));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toBe('payload_too_large');
  });

  it('varies on Accept-Encoding without dropping the CORS Vary: Origin', async () => {
    const res = await makeHandler()(
      event({ query: PUZZLE_QUERY, headers: { 'accept-encoding': 'gzip' } }),
    );
    const vary = res.headers['Vary'].split(',').map((f) => f.trim());
    expect(vary).toContain('Accept-Encoding');
    expect(vary).toContain('Origin');
  });

  it('honours an explicit gzip;q=0 refusal', async () => {
    const res = await oversizedHandler()(
      event({ query: PUZZLE_QUERY, headers: { 'accept-encoding': 'gzip;q=0, identity' } }),
    );
    expect(res.headers['Content-Encoding']).toBeUndefined();
    expect(res.statusCode).toBe(500); // too big to send uncompressed — named, not a 502
  });

  it('leaves a sub-kilobyte puzzle uncompressed even when gzip is offered', async () => {
    const res = await makeHandler()(
      event({ query: PUZZLE_QUERY, headers: { 'accept-encoding': 'gzip' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Encoding']).toBeUndefined();
    expect(JSON.parse(res.body)).toEqual(PUZZLE);
  });
});

describe('share-card /og route — lang passthrough (#59)', () => {
  it('forwards the token language into the card renderer', async () => {
    const token = encodeResult({
      lang: 'fr',
      dayNumber: 20638,
      score: 6,
      trajectory: [8, 8, 33, 33, 70, 100],
      solvedAt: [3, 6, 5],
    });
    const res = await makeHandler()(event({ path: `/og/${token}.png` }));
    expect(res.statusCode).toBe(200);
    expect(renderCardPng).toHaveBeenCalledWith(expect.objectContaining({ lang: 'fr' }));
  });
});

describe('CORS preflight', () => {
  it('OPTIONS -> 204 with CORS headers and no body', async () => {
    const res = await makeHandler()(event({ method: 'OPTIONS' }));
    expect(res.statusCode).toBe(204);
    expect(res.headers['Access-Control-Allow-Origin']).toBe(ORIGIN);
    expect(res.headers['Access-Control-Allow-Methods']).toMatch(/GET/);
    expect(res.body).toBe('');
  });
});

describe('today diagnostic endpoint — the server\'s view of the active day', () => {
  it('exposes the server day and reset info', async () => {
    const res = await makeHandler()(event({ path: '/today' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.date).toBe(ACTIVE_DATE);
    expect(typeof body.dayNumber).toBe('number');
    expect(body.timeZone).toBe('America/New_York');
    expect(typeof body.secondsUntilNextReset).toBe('number');
    expect(body.nextResetAt).toBe('2026-06-30T02:00:00.000Z');
  });

  it('is never cached (no-store) so it always reflects the live server clock', async () => {
    const res = await makeHandler()(event({ path: '/today' }));
    expect(res.headers['Cache-Control']).toBe('no-store');
  });
});
