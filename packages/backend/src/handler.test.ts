// CONTRACT (issue #2 acceptance criteria): the handler resolves the day's puzzle for a
// requested lang, returns it in the front's `Puzzle` shape, answers a missing puzzle
// with a clean JSON 404 (never a 500), sends CORS headers, and exposes day metadata.

import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  type Puzzle,
  type WordPuzzle,
  anonName,
  blankAvatar,
  dateForDayNumber,
  encodeResult,
  encodeWordResult,
  inviteCardPath,
  inviteLandingPath,
  INVITE_SEGMENT,
} from '@whippin/shared';
import { createHandler, type HandlerDeps } from './handler';
import { renderCardPng, renderInviteCardPng } from './ogCard';
import type { ProfileRecord, ProfileStore } from './profileStore';
import { LAMBDA_MAX_RESPONSE_BYTES, envelopeBytes, type FnUrlEvent } from './respond';
import type { PuzzleStore } from './store';

// Spy on the card rasterizer (real PNG bytes are opaque to a lang assertion); a stub PNG
// lets us assert the /og route forwards the token's lang into the renderer.
vi.mock('./ogCard', async () => {
  const actual = await vi.importActual<typeof import('./ogCard')>('./ogCard');
  const stub = () => vi.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return { ...actual, renderCardPng: stub(), renderInviteCardPng: stub() };
});

// A minimal but schema-valid puzzle, keyed by the date the fixed clock resolves to.
const PUZZLE: Puzzle = {
  lang: 'fr',
  revision: 'd4e5f60718293040',
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

// Word mode's #154 artifact for the same days (#156): served by the same endpoint under
// `mode=word`, from its own store key.
const WORD_PUZZLE: WordPuzzle = {
  lang: 'fr',
  word: { word: 'forêt', slug: 'foret' },
  ranks: {
    foret: { word: 'forêt', rank: 0 },
    bois: { word: 'bois', rank: 1, dq: 255 },
  },
};

function fakeStore(): PuzzleStore {
  return {
    async getPuzzle(date, lang) {
      return PUBLISHED_FR.has(date) && lang === 'fr' ? PUZZLE : null;
    },
    async getWordPuzzle(date, lang) {
      return PUBLISHED_FR.has(date) && lang === 'fr' ? WORD_PUZZLE : null;
    },
    async getSlice() {
      return null;
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
    store: {
      async getPuzzle(date, lang) { return date === ACTIVE_DATE && lang === 'fr' ? puzzle : null; },
      async getWordPuzzle() { return null; },
      async getSlice() { return null; },
    },
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

  // --- Word mode (#156): the same endpoint serves the #154 artifact under mode=word,
  // with the sentence contract's date-addressing, 404 semantics and caching.
  it('mode=word serves the word artifact for the (date, lang), unchanged', async () => {
    const res = await makeHandler()(
      event({ query: { lang: 'fr', date: ACTIVE_DATE, mode: 'word' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(WORD_PUZZLE);
    expect(res.headers['Cache-Control']).toContain('s-maxage=31536000');
  });

  it('mode=sentence (explicit) serves the sentence puzzle', async () => {
    const res = await makeHandler()(
      event({ query: { lang: 'fr', date: ACTIVE_DATE, mode: 'sentence' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(PUZZLE);
  });

  it('an unknown mode -> 400 bad_request (protocol violation)', async () => {
    const res = await makeHandler()(
      event({ query: { lang: 'fr', date: ACTIVE_DATE, mode: 'sonnet' } }),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('bad_request');
  });

  it('a missing word artifact -> clean 404, even when the sentence day exists', async () => {
    const handler = makeHandler({
      store: {
        async getPuzzle() {
          return PUZZLE;
        },
        async getWordPuzzle() {
          return null;
        },
        async getSlice() {
          return null;
        },
      },
    });
    const res = await handler(event({ query: { lang: 'fr', date: ACTIVE_DATE, mode: 'word' } }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('not_found');
  });

  it('mode=word keeps the future guard: active day +2 -> 404 before the store', async () => {
    const res = await makeHandler()(
      event({ query: { lang: 'fr', date: DAY_AFTER_NEXT, mode: 'word' } }),
    );
    expect(res.statusCode).toBe(404);
  });

  it('mode=word serves any archive past day', async () => {
    const res = await makeHandler()(
      event({ query: { lang: 'fr', date: PAST_30, mode: 'word' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(WORD_PUZZLE);
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
        async getWordPuzzle() {
          throw new Error('s3 boom');
        },
        async getSlice() {
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
  // The oversize guard writes to console.error. Capture it so the suite output stays clean
  // and so the log line itself can be asserted.
  const captureConsoleError = () => vi.spyOn(console, 'error').mockImplementation(() => {});
  let logged: ReturnType<typeof captureConsoleError>;
  beforeEach(() => {
    logged = captureConsoleError();
  });
  afterEach(() => {
    logged.mockRestore();
  });

  it('prefers brotli when the client offers it — CloudFront would, so gzip-only would regress', async () => {
    const res = await oversizedHandler()(
      event({ query: PUZZLE_QUERY, headers: { 'accept-encoding': 'br, gzip, deflate' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Encoding']).toBe('br');
    expect(res.isBase64Encoded).toBe(true);
    // The point of the exercise: what the runtime will post back now fits.
    expect(envelopeBytes(res)).toBeLessThan(LAMBDA_MAX_RESPONSE_BYTES);
    expect(JSON.parse(brotliDecompressSync(Buffer.from(res.body, 'base64')).toString('utf8'))).toEqual(
      oversizedPuzzle(),
    );
  });

  it('serves gzip — and the body decodes back to the exact puzzle', async () => {
    const res = await oversizedHandler()(
      event({ query: PUZZLE_QUERY, headers: { 'accept-encoding': 'gzip' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Encoding']).toBe('gzip');
    expect(envelopeBytes(res)).toBeLessThan(LAMBDA_MAX_RESPONSE_BYTES);
    const decoded = JSON.parse(gunzipSync(Buffer.from(res.body, 'base64')).toString('utf8'));
    expect(decoded).toEqual(oversizedPuzzle());
  });

  it('serves a br-only client, which CloudFront can produce by normalizing the header', async () => {
    // CloudFront strips everything but the br/gzip the viewer offered, so `br` can arrive
    // alone. A gzip-only origin would answer this request uncompressed — which for a puzzle
    // is not an answer at all.
    const res = await oversizedHandler()(
      event({ query: PUZZLE_QUERY, headers: { 'accept-encoding': 'br' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Encoding']).toBe('br');
    expect(envelopeBytes(res)).toBeLessThan(LAMBDA_MAX_RESPONSE_BYTES);
  });

  it('an oversized puzzle a client cannot accept gzipped is a NAMED 500, not a silent 502', async () => {
    // No Accept-Encoding: nothing can shrink the payload, so the handler must own the
    // failure. That this fires at all is also what proves the fixture is genuinely over
    // the cap — the guard has no other trigger.
    const res = await oversizedHandler()(event({ query: PUZZLE_QUERY }));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toBe('payload_too_large');
  });

  it('LOGS the oversized payload, because a returned 500 is invisible to the operator', async () => {
    // The reason this is asserted rather than assumed: a handler that RETURNS an error
    // status is a SUCCESSFUL invocation, so Lambda's Errors metric stays 0 and the log
    // group shows a clean request. The console line is the ONLY thing that puts this in
    // CloudWatch — drop it in a refactor and the next oversized puzzle is diagnosed by
    // curling again, which is the exact failure this PR set out to end.
    await oversizedHandler()(event({ query: PUZZLE_QUERY }));
    expect(logged).toHaveBeenCalledTimes(1);
    const line = logged.mock.calls[0][0] as string;
    expect(line).toContain('payload_too_large');
    expect(line).toContain(ACTIVE_DATE); // which day to republish
    expect(line).toContain('fr'); // and in which language
    expect(line).toMatch(/\d{7}/); // the size that busted the budget
  });

  it('stays silent on a response that fits', async () => {
    await oversizedHandler()(
      event({ query: PUZZLE_QUERY, headers: { 'accept-encoding': 'br' } }),
    );
    expect(logged).not.toHaveBeenCalled();
  });

  it('varies on Accept-Encoding without dropping the CORS Vary: Origin', async () => {
    const res = await makeHandler()(
      event({ query: PUZZLE_QUERY, headers: { 'accept-encoding': 'gzip' } }),
    );
    const vary = res.headers['Vary'].split(',').map((f) => f.trim());
    expect(vary).toContain('Accept-Encoding');
    expect(vary).toContain('Origin');
  });

  it('honours explicit q=0 refusals rather than reading the token as consent', async () => {
    const res = await oversizedHandler()(
      event({ query: PUZZLE_QUERY, headers: { 'accept-encoding': 'br;q=0, gzip;q=0, identity' } }),
    );
    expect(res.headers['Content-Encoding']).toBeUndefined();
    expect(res.statusCode).toBe(500); // too big to send uncompressed — named, not a 502
  });

  it('falls back to gzip when brotli alone is refused', async () => {
    const res = await oversizedHandler()(
      event({ query: PUZZLE_QUERY, headers: { 'accept-encoding': 'br;q=0, gzip' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Encoding']).toBe('gzip');
  });

  it.each(['gzip', 'br, gzip, deflate'])(
    'leaves a sub-kilobyte puzzle uncompressed even when the client offers %s',
    async (acceptEncoding) => {
      const res = await makeHandler()(
        event({ query: PUZZLE_QUERY, headers: { 'accept-encoding': acceptEncoding } }),
      );
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Encoding']).toBeUndefined();
      expect(JSON.parse(res.body)).toEqual(PUZZLE);
    },
  );
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

  // The route hands the DECODED result straight to the renderer. It used to re-list the
  // fields, which silently dropped whatever the codec learned next — #214's `capped` went
  // that way, drawing a try count on a card whose own share page already said `∞`.
  it('forwards EVERYTHING the codec decoded, the capped flag included (#214)', async () => {
    const token = encodeResult({
      lang: 'en',
      dayNumber: 20638,
      score: 500,
      trajectory: Array.from({ length: 500 }, (_, i) => i / 5),
      solvedAt: [],
      capped: true,
    });
    const res = await makeHandler()(event({ path: `/og/${token}.png` }));
    expect(res.statusCode).toBe(200);
    expect(renderCardPng).toHaveBeenCalledWith(expect.objectContaining({ capped: true }));
    // And the share PAGE agrees with the card it points at.
    const page = await makeHandler()(event({ path: `/s/${token}` }));
    expect(page.body).toContain('∞ tries');
    expect(page.body).not.toContain('500 tries');
  });
});

describe('word-mode share routes (#156)', () => {
  // 12 claims broken down by rarity (v5): the page's headline is the counts' sum.
  const wordToken = encodeWordResult({
    lang: 'fr',
    dayNumber: 20638,
    counts: [7, 3, 1, 1, 0],
    word: 'forêt',
  });

  it('/s/<word token> serves the share page, click-through to the word route', async () => {
    const res = await makeHandler()(event({ path: `/s/${wordToken}` }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toMatch(/text\/html/);
    // The token names the day; the page sends the reader to that day's WORD route.
    expect(res.body).toContain(`/fr/word/${dateForDayNumber(20638)}`);
    expect(res.body).toContain('12 mots');
  });

  it('/og/<word token>.png renders a PNG', async () => {
    const res = await makeHandler()(event({ path: `/og/${wordToken}.png` }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toMatch(/image\/png/);
  });
});

// CONTRACT (#189, preview added 2026-08-20): `/i/<publicId>` is the link a player SHARES,
// so the server owns it — the page a chat unfurls carries that player's own name and
// mark, and it bounces a human onto the SPA landing that actually records the edge. The
// two paths come from `shared/invite.ts` here and in `web/langs.ts`, which is what keeps
// the bounce landing somewhere the app routes.
describe('invite link (#189) — the shared link, its preview page and its card', () => {
  const ID = 'abcdefghij234567';
  const stored = (row: ProfileRecord | null, fails = false, live = true): ProfileStore => ({
    async get() {
      if (fails) throw new Error('profile store is down');
      return { live, profile: row };
    },
    async create() {
      return false;
    },
    async upsert() {},
  });
  const drawn = blankAvatar(2);

  it('serves the preview page: the player named, their card, the landing to bounce to', async () => {
    const res = await makeHandler({
      siteOrigin: ORIGIN,
      profiles: stored({ publicId: ID, name: 'Chqrles', avatar: drawn }),
    })(event({ path: `/${INVITE_SEGMENT}/${ID}` }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toMatch(/text\/html/);
    // The title says the two things the card says, and nothing else.
    expect(res.body).toContain('<title>Whippin AI — Chqrles</title>');
    expect(res.body).toContain(`${ORIGIN}${inviteCardPath(ID)}`);
    // The click continues to the SPA landing — the one that records the mutual edge.
    expect(res.body).toContain(`${ORIGIN}${inviteLandingPath(ID)}`);
  });

  it('names the ASSIGNED identity for a player who never customized one', async () => {
    const res = await makeHandler({ siteOrigin: ORIGIN, profiles: stored(null) })(
      event({ path: `/${INVITE_SEGMENT}/${ID}` }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`<title>Whippin AI — ${anonName(ID)}</title>`);
  });

  it('a trailing slash is the same link (a pasted one often carries one)', async () => {
    const res = await makeHandler({ siteOrigin: ORIGIN, profiles: stored(null) })(
      event({ path: `/${INVITE_SEGMENT}/${ID}/` }),
    );
    expect(res.statusCode).toBe(200);
  });

  it('a malformed id is a 404 — never a lookup for an id nobody can hold', async () => {
    const profiles = stored(null);
    const get = vi.spyOn(profiles, 'get');
    const handler = makeHandler({ siteOrigin: ORIGIN, profiles });
    for (const bad of ['nope', 'abcdefghij234560', `${ID}x`]) {
      const res = await handler(event({ path: `/${INVITE_SEGMENT}/${bad}` }));
      expect(res.statusCode).toBe(404);
    }
    expect(get).not.toHaveBeenCalled();
  });

  it('renders the card from the STORED profile, empty avatar read as none', async () => {
    const res = await makeHandler({
      profiles: stored({ publicId: ID, name: 'Chqrles', avatar: '' }),
    })(event({ path: inviteCardPath(ID) }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toMatch(/image\/png/);
    expect(renderInviteCardPng).toHaveBeenCalledWith({
      publicId: ID,
      name: 'Chqrles',
      avatar: null,
    });
  });

  it('caches an answered read, but NEVER a face it had to fall back to', async () => {
    const answered = await makeHandler({ siteOrigin: ORIGIN, profiles: stored(null) })(
      event({ path: `/${INVITE_SEGMENT}/${ID}` }),
    );
    expect(answered.headers['Cache-Control']).toMatch(/max-age=\d+/);

    // A read that FAILED is not the answer "never customized": holding the assigned
    // identity at the edge would put a stranger's face on a player who drew their own.
    const failed = await makeHandler({
      siteOrigin: ORIGIN,
      profiles: stored(null, true),
    })(event({ path: `/${INVITE_SEGMENT}/${ID}` }));
    expect(failed.statusCode).toBe(200);
    expect(failed.headers['Cache-Control']).toBe('no-store');
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
