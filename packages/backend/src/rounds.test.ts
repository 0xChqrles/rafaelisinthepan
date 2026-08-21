// CONTRACT (#201): /round is the server-authoritative guess log — POST-only (the secret
// is the auth and travels in the body), addressed per (date, lang, mode) by the shared
// guard triple, storing the RAW ordered log as strings with no interpretation. The read
// answers the stored round (404 = none yet); the append validates every guess (folded
// slug shape, the language's own max length from #200), enforces the 500-guess cap and
// the ~1s per-player write interval in ONE atomic decision, and EVERY answer — the two
// refusals included — carries the full state so a write is also a reconciliation.
// Archive days sync like today's, and a re-published daily restarts the log rather than
// handing back the retired puzzle's.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecret, ROUND_GUESS_CAP, ROUND_WRITE_MIN_MS } from '@whippin/shared';
import { createHandler } from './handler';
import { memoryRoundStore } from './memoryRoundStore';
import type { FnUrlEvent } from './respond';
import type { PuzzleStore } from './store';

const START = new Date('2026-08-21T14:00:00Z');
const ACTIVE_DATE = '2026-08-21';
const PAST_DATE = '2026-08-19';
const FUTURE_DATE = '2026-08-23';
const ORIGIN = 'https://whippin.example';
const SECRET = generateSecret();
const PUZZLE = 'a1b2c3d4';

function puzzleStore(): PuzzleStore {
  return {
    // The round route reads NO puzzle store — asserted by never being called.
    async getPuzzle() {
      throw new Error('the round route must not read the puzzle store');
    },
    async getWordPuzzle() {
      throw new Error('the round route must not read the puzzle store');
    },
  };
}

// One handler per test, over ONE memory store, driven by an advancing clock: sequences
// of writes must land on the same record, and the interval needs real time movement.
function makeHandler() {
  let current = START.getTime();
  const handler = createHandler({
    store: puzzleStore(),
    now: () => new Date(current),
    allowedOrigin: ORIGIN,
    rounds: memoryRoundStore(),
  });
  return Object.assign(handler, {
    advance(ms: number) {
      current += ms;
    },
  });
}

// Every call carries the player key AND the tag naming which puzzle the log belongs to.
function body(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { secret: SECRET, puzzle: PUZZLE, ...extra };
}

function event(options: {
  method?: string;
  query?: Record<string, string>;
  body?: unknown;
} = {}): FnUrlEvent {
  return {
    rawPath: '/round',
    queryStringParameters:
      options.query ?? { lang: 'fr', date: ACTIVE_DATE, mode: 'sentence' },
    requestContext: { http: { method: options.method ?? 'POST', sourceIp: '127.0.0.1' } },
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(options.body === undefined ? body() : options.body),
  };
}

interface RoundResponse {
  guesses: string[];
  createdAt: string;
}

function parsed(response: { body: string }): RoundResponse {
  return JSON.parse(response.body) as RoundResponse;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('protocol', () => {
  it('is POST-only: the player key authenticates in the body', async () => {
    const response = await makeHandler()(event({ method: 'GET' }));
    expect(response.statusCode).toBe(405);
    expect(response.headers['Cache-Control']).toBe('no-store');
  });

  it.each([
    [{ date: ACTIVE_DATE, mode: 'sentence' }, 'missing lang'],
    [{ lang: 'de', date: ACTIVE_DATE, mode: 'sentence' }, 'unsupported lang'],
    [{ lang: 'fr', date: ACTIVE_DATE }, 'missing mode'],
    [{ lang: 'fr', date: ACTIVE_DATE, mode: 'crossword' }, 'unknown mode'],
    [{ lang: 'fr', mode: 'sentence' }, 'missing date'],
    [{ lang: 'fr', date: 'not-a-date', mode: 'sentence' }, 'malformed date'],
  ] as [Record<string, string>, string][])('refuses %s (%s)', async (query) => {
    const response = await makeHandler()(event({ query }));
    expect(response.statusCode).toBe(400);
  });

  it('serves no day beyond the +1 future-skew window', async () => {
    const response = await makeHandler()(
      event({ query: { lang: 'fr', date: FUTURE_DATE, mode: 'sentence' } }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('refuses a malformed player key', async () => {
    const response = await makeHandler()(event({ body: { secret: 'nope', puzzle: PUZZLE } }));
    expect(response.statusCode).toBe(400);
  });

  it.each([
    [undefined, 'missing'],
    ['', 'empty'],
    ['NOT-A-TAG', 'wrong charset'],
    ['a'.repeat(33), 'over-long'],
  ] as [unknown, string][])('refuses a %s puzzle tag (%s)', async (puzzle) => {
    const response = await makeHandler()(event({ body: { secret: SECRET, puzzle } }));
    expect(response.statusCode).toBe(400);
  });

  it("never reads the puzzle store — archive days sync like today's", async () => {
    const response = await makeHandler()(
      event({ query: { lang: 'fr', date: PAST_DATE, mode: 'sentence' }, body: body() }),
    );
    // Honest "none yet" from the round store, not a puzzle-store miss.
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error).toBe('not_found');
  });
});

describe('read', () => {
  it('answers 404 for a round the server holds nothing for', async () => {
    const response = await makeHandler()(event());
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error).toBe('not_found');
  });

  it('answers the full stored state after a write', async () => {
    const handler = makeHandler();
    await handler(event({ body: body({ guesses: ['foret'] }) }));
    const response = await handler(event());
    expect(response.statusCode).toBe(200);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(parsed(response)).toMatchObject({ guesses: ['foret'] });
    expect(parsed(response).createdAt).toBeTruthy();
  });
});

describe('append', () => {
  it('creates the record on the first write and accumulates in order', async () => {
    const handler = makeHandler();
    const first = await handler(event({ body: body({ guesses: ['bois'] }) }));
    expect(first.statusCode).toBe(200);
    expect(parsed(first)).toMatchObject({ guesses: ['bois'] });

    handler.advance(ROUND_WRITE_MIN_MS + 1);
    const second = await handler(event({ body: body({ guesses: ['foret', 'chemin'] }) }));
    expect(second.statusCode).toBe(200);
    expect(parsed(second)).toMatchObject({ guesses: ['bois', 'foret', 'chemin'] });
  });

  it('stores the RAW log — repeats included, nothing interpreted', async () => {
    const handler = makeHandler();
    const response = await handler(event({ body: body({ guesses: ['bois', 'bois'] }) }));
    expect(response.statusCode).toBe(200);
    expect(parsed(response)).toMatchObject({ guesses: ['bois', 'bois'] });
  });

  it.each([
    // (A body with NO `guesses` field is a READ by design — covered above.)
    ['bois', 'not an array'],
    [[], 'empty'],
    [['bois', 3], 'non-string entry'],
    [Array.from({ length: ROUND_GUESS_CAP + 1 }, () => 'a'), 'over-cap batch'],
  ] as [unknown, string][])('refuses a malformed batch (%s)', async (guesses) => {
    const response = await makeHandler()(event({ body: body({ guesses }) }));
    expect(response.statusCode).toBe(400);
  });

  it("refuses a guess longer than the language's max slug (#200)", async () => {
    // fr's longest vocabulary slug is 25 characters; anything longer was never typed.
    const response = await makeHandler()(event({ body: body({ guesses: ['a'.repeat(26)] }) }));
    expect(response.statusCode).toBe(400);
  });

  it("accepts a guess exactly at the language's max slug", async () => {
    const response = await makeHandler()(event({ body: body({ guesses: ['a'.repeat(25)] }) }));
    expect(response.statusCode).toBe(200);
  });

  it('refuses anything fold() would change — the slug contract, not a local copy', async () => {
    for (const bad of ['Éléonore', '-bois', 'bois-', 'deux--mots', 'mot1', '', 'Bois', 'arc en ciel']) {
      const response = await makeHandler()(event({ body: body({ guesses: [bad] }) }));
      expect(response.statusCode).toBe(400);
    }
  });

  it('accepts the folded forms the game can actually produce', async () => {
    const handler = makeHandler();
    const response = await handler(event({ body: body({ guesses: ['arc-en-ciel', 'peut-etre'] }) }));
    expect(response.statusCode).toBe(200);
  });
});

describe('a re-published daily restarts the log (#201)', () => {
  it('answers 404 for a log the RETIRED puzzle wrote', async () => {
    const handler = makeHandler();
    await handler(event({ body: body({ guesses: ['ancien'] }) }));
    handler.advance(ROUND_WRITE_MIN_MS + 1);

    // The same (date, lang, mode) key, a different sentence under it. The client reset
    // its local round on exactly this change; handing back the old log would undo that.
    const read = await handler(event({ body: { secret: SECRET, puzzle: 'deadbeef' } }));
    expect(read.statusCode).toBe(404);
  });

  it('REPLACES the retired log on the next append instead of growing it', async () => {
    const handler = makeHandler();
    await handler(event({ body: body({ guesses: ['ancien'] }) }));
    handler.advance(ROUND_WRITE_MIN_MS + 1);

    const restarted = await handler(
      event({ body: { secret: SECRET, puzzle: 'deadbeef', guesses: ['bois'] } }),
    );
    expect(restarted.statusCode).toBe(200);
    expect(parsed(restarted).guesses).toEqual(['bois']);

    // And the new tag is what the record now answers to.
    handler.advance(ROUND_WRITE_MIN_MS + 1);
    const read = await handler(event({ body: { secret: SECRET, puzzle: 'deadbeef' } }));
    expect(parsed(read).guesses).toEqual(['bois']);
  });
});

describe('the cap (#201)', () => {
  // ROUND_GUESS_CAP distinct folded slugs (letters only — digits are not slug chars).
  function capBatch(): string[] {
    return Array.from({ length: ROUND_GUESS_CAP }, (_, i) =>
      `${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`,
    );
  }

  it(`refuses appends past ${ROUND_GUESS_CAP} stored guesses, changing nothing`, async () => {
    const handler = makeHandler();
    // Fill to exactly the cap in one write (allowed: the RESULT may reach it).
    const fill = await handler(event({ body: body({ guesses: capBatch() }) }));
    expect(fill.statusCode).toBe(200);

    handler.advance(ROUND_WRITE_MIN_MS + 1);
    const refused = await handler(event({ body: body({ guesses: ['one-more'] }) }));
    expect(refused.statusCode).toBe(409);
    expect(JSON.parse(refused.body).error).toBe('round_full');
    // The refusal IS an answer: it carries the UNCHANGED stored log, which is the truth
    // the client reconciles against (and what pays for the classification read).
    expect(parsed(refused).guesses).toHaveLength(ROUND_GUESS_CAP);
    expect(parsed(refused).createdAt).toBeTruthy();

    const read = await handler(event());
    expect(read.statusCode).toBe(200);
    expect(parsed(read).guesses).toHaveLength(ROUND_GUESS_CAP);
  });

  it('counts cap hits where they can be reviewed', async () => {
    const warn = vi.spyOn(console, 'warn');
    const handler = makeHandler();
    await handler(event({ body: body({ guesses: capBatch() }) }));
    handler.advance(ROUND_WRITE_MIN_MS + 1);
    await handler(event({ body: body({ guesses: ['x'] }) }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('round_full');
  });
});

describe('the ~1s per-player write interval', () => {
  it('refuses a write sooner than the interval, keeping the stored log intact', async () => {
    const handler = makeHandler();
    await handler(event({ body: body({ guesses: ['bois'] }) }));
    const refused = await handler(event({ body: body({ guesses: ['foret'] }) }));
    expect(refused.statusCode).toBe(429);
    expect(JSON.parse(refused.body).error).toBe('too_fast');
    expect(refused.headers['Retry-After']).toBe('1');
    // A browser can read no response header outside the CORS safelist unless it is
    // exposed — an unexposed Retry-After is a value only curl ever sees.
    expect(refused.headers['Access-Control-Expose-Headers']).toContain('Retry-After');
    // The rate refusal carries the stored log too: a client refused mid-sync must not be
    // left stale until its next accepted write.
    expect(parsed(refused).guesses).toEqual(['bois']);

    const read = await handler(event());
    expect(parsed(read)).toMatchObject({ guesses: ['bois'] });
  });

  it('accepts the next write once the interval has passed', async () => {
    const handler = makeHandler();
    await handler(event({ body: body({ guesses: ['bois'] }) }));
    handler.advance(ROUND_WRITE_MIN_MS + 1);
    const ok = await handler(event({ body: body({ guesses: ['foret'] }) }));
    expect(ok.statusCode).toBe(200);
    expect(parsed(ok)).toMatchObject({ guesses: ['bois', 'foret'] });
  });
});

describe('preflight', () => {
  it('lets the browser cache one permission check across a round of writes', async () => {
    const response = await makeHandler()(event({ method: 'OPTIONS' }));
    expect(response.statusCode).toBe(204);
    // Without it the default preflight cache is a few seconds, so a round writing about
    // once a second pays an extra OPTIONS invocation and an RTT stall every few guesses.
    expect(Number(response.headers['Access-Control-Max-Age'])).toBeGreaterThan(0);
    expect(response.headers['Cache-Control']).toBeUndefined();
  });
});

describe('identity', () => {
  it('keys rounds by the DERIVED publicId — another key reads another round', async () => {
    const handler = makeHandler();
    await handler(event({ body: body({ guesses: ['bois'] }) }));
    const other = await handler(event({ body: { secret: generateSecret(), puzzle: PUZZLE } }));
    expect(other.statusCode).toBe(404);
  });
});
