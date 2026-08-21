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
import {
  generateSecret,
  ROUND_GUESS_CAP,
  ROUND_WRITE_MIN_MS,
  WORD_MISS_CAP,
  wordRunFloorMs,
  type WordPuzzle,
} from '@whippin/shared';
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

// The day's word artifact, for the ONE path that reads a puzzle store (#202's end-of-run
// submission). Three claimable groups inside the zone plus one far outside it, so the
// artifact's own ceiling — not the zone constant — is what an over-claiming log is refused
// against.
const WORD_ARTIFACT: WordPuzzle = {
  lang: 'fr',
  word: { word: 'phare', slug: 'phare' },
  ranks: {
    phare: { word: 'phare', rank: 0, freq: 5_000 },
    mer: { word: 'mer', rank: 1, dq: 255, freq: 100 },
    ocean: { word: 'océan', rank: 2, dq: 200, freq: 800 },
    bateau: { word: 'bateau', rank: 3, dq: 100, freq: 1_200 },
    loin: { word: 'loin', rank: 5_000, dq: 0, freq: 300 },
  },
};

// `undefined` = the store must never be touched (every sentence path, and every word path
// but the submission); `null` = the daily was never published.
function puzzleStore(word?: WordPuzzle | null): PuzzleStore {
  return {
    // NOTHING here reads the sentence puzzle — asserted by never being called.
    async getPuzzle() {
      throw new Error('the round route must not read the puzzle store');
    },
    async getWordPuzzle() {
      if (word === undefined) throw new Error('the round route must not read the puzzle store');
      return word;
    },
  };
}

// One handler per test, over ONE memory store, driven by an advancing clock: sequences
// of writes must land on the same record, and the interval needs real time movement.
function makeHandler(
  options: { word?: WordPuzzle | null; turnstile?: boolean } = {},
) {
  let current = START.getTime();
  const handler = createHandler({
    store: puzzleStore(options.word),
    now: () => new Date(current),
    allowedOrigin: ORIGIN,
    rounds: {
      roundStore: memoryRoundStore(),
      turnstile: { async verify() { return options.turnstile !== false; } },
      allowSourceIp: true,
    },
  });
  return Object.assign(handler, {
    advance(ms: number) {
      current += ms;
    },
  });
}

// A word round's own addressing + tag: everything the two word writes share.
const WORD_QUERY = { lang: 'fr', date: ACTIVE_DATE, mode: 'word' };
const WORD_TAG = 'w0rd';

function wordEvent(extra: Record<string, unknown> = {}, query = WORD_QUERY): FnUrlEvent {
  return event({ query, body: { secret: SECRET, puzzle: WORD_TAG, ...extra } });
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
  startedAt?: string;
  now: string;
  error?: string;
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

  it('never hands the retired log back on a rate-refused restart', async () => {
    const handler = makeHandler();
    await handler(event({ body: body({ guesses: ['ancien'] }) }));

    // The corrected puzzle's first flush lands INSIDE the write interval. Every answer,
    // refusals included, is adopted by the client as this round's truth — so a 429
    // carrying the retired sentence's log would reintroduce exactly the guesses the tag
    // exists to exclude.
    const refused = await handler(
      event({ body: { secret: SECRET, puzzle: 'deadbeef', guesses: ['bois'] } }),
    );
    expect(refused.statusCode).toBe(429);
    expect(parsed(refused).guesses).toEqual([]);
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

  it('does NOT count a batch that merely OVERSHOOTS a round with room left', async () => {
    // A second device pushed the log forward while this caller was away, so its batch —
    // correctly sized when it was built — no longer fits. That refuses the BATCH, not the
    // round: the stored log still has room, so it is not the "unreachable secret" signal
    // the line exists to collect, and counting it would let a racing device manufacture
    // curation noise.
    const warn = vi.spyOn(console, 'warn');
    const handler = makeHandler();
    await handler(event({ body: body({ guesses: capBatch().slice(0, ROUND_GUESS_CAP - 1) }) }));
    handler.advance(ROUND_WRITE_MIN_MS + 1);

    const refused = await handler(event({ body: body({ guesses: ['aa', 'ab'] }) }));
    expect(refused.statusCode).toBe(409);
    expect(warn).not.toHaveBeenCalled();
    // The refusal still carries the truth, which is what lets the client re-size instead
    // of concluding the round is over.
    expect(parsed(refused).guesses).toHaveLength(ROUND_GUESS_CAP - 1);
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

  it('binds one DAILY, not the player across dailies', async () => {
    // `lastWriteAt` lives on the round item, so the bound is per (player, daily) — which
    // is the granularity the CLIENT paces at (one flight per round key, each timing its
    // own last answer). A global per-player throttle would make two concurrently syncing
    // rounds — an archive day left mid-play and today's — refuse each other about half
    // the time, which is the two ends measuring different things: exactly what one
    // shared constant exists to prevent. See the root AGENTS.md.
    const handler = makeHandler();
    await handler(event({ body: body({ guesses: ['bois'] }) }));
    const other = await handler(
      event({
        query: { lang: 'fr', date: PAST_DATE, mode: 'sentence' },
        body: body({ guesses: ['foret'] }),
      }),
    );
    expect(other.statusCode).toBe(200);
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

// CONTRACT (#202): Word mode writes exactly TWICE on this same route. START is a
// Turnstile-gated write stamping the round's clock from the SERVER's own clock — not for
// cheat prevention (the artifact is public) but so the end-of-run wait check has an anchor
// the client cannot backdate. SUBMIT carries the WHOLE log once, first write wins, no
// earlier than the run's own floor (`START_SECONDS + MIN_BONUS × claims`, which honest play
// can never undercut because Word mode has no early finish). The claims are validated
// against the day's artifact — the ONE path here that reads a puzzle store — and the caps
// are the client's own, enforced because a malicious client will not truncate.
describe('word mode: the round start (#202)', () => {
  it('stamps the clock from the SERVER and answers it with the server instant', async () => {
    const handler = makeHandler();
    const response = await handler(wordEvent({ turnstileToken: 'ok' }));
    expect(response.statusCode).toBe(200);
    const state = parsed(response);
    expect(state.startedAt).toBe(START.toISOString());
    // Every answer carries the server's own clock: what a client keeps is the ELAPSED span
    // between the two, which no device-clock skew can misread.
    expect(state.now).toBe(START.toISOString());
    expect(state.guesses).toEqual([]);
  });

  it('is IDEMPOTENT per word — a second tap resumes the one clock, never a fresh minute', async () => {
    const handler = makeHandler();
    await handler(wordEvent({ turnstileToken: 'ok' }));
    handler.advance(5_000);
    const again = await handler(wordEvent({ turnstileToken: 'ok' }));
    expect(again.statusCode).toBe(200);
    expect(parsed(again).startedAt).toBe(START.toISOString());
    expect(parsed(again).now).toBe(new Date(START.getTime() + 5_000).toISOString());
  });

  it('restarts the round when a DIFFERENT word is published under the same key', async () => {
    const handler = makeHandler();
    await handler(wordEvent({ turnstileToken: 'ok' }));
    handler.advance(5_000);
    const restarted = await handler(
      event({ query: WORD_QUERY, body: { secret: SECRET, puzzle: 'other', turnstileToken: 'ok' } }),
    );
    expect(parsed(restarted).startedAt).toBe(new Date(START.getTime() + 5_000).toISOString());
    // …and the retired word's round is gone, not merely renamed.
    const stale = await handler(wordEvent({ turnstileToken: 'ok' }));
    expect(parsed(stale).startedAt).toBe(new Date(START.getTime() + 5_000).toISOString());
  });

  it.each([
    [{}, 'missing'],
    [{ turnstileToken: '' }, 'empty'],
    [{ turnstileToken: 'x'.repeat(3_000) }, 'implausibly long'],
  ] as [Record<string, unknown>, string][])(
    'refuses a %s Turnstile token (%s)',
    async (extra) => {
      const handler = makeHandler();
      // An empty/oversized token is refused as the authentication failure it is; a MISSING
      // one is not a start at all, so it reads the (nonexistent) round instead.
      const response = await handler(wordEvent(extra));
      expect(response.statusCode).toBe(Object.keys(extra).length === 0 ? 404 : 403);
    },
  );

  it('refuses a token Siteverify rejects', async () => {
    const handler = makeHandler({ turnstile: false });
    const response = await handler(wordEvent({ turnstileToken: 'forged' }));
    expect(response.statusCode).toBe(403);
    expect(parsed(response).error).toBe('turnstile_rejected');
  });

  it('has no meaning on a SENTENCE round, whose log streams and needs no clock', async () => {
    const handler = makeHandler();
    const response = await handler(event({ body: body({ turnstileToken: 'ok' }) }));
    expect(response.statusCode).toBe(400);
  });

  it('is never the same call as a submission', async () => {
    const handler = makeHandler();
    // The two word writes are separate messages and no client sends both. Dispatching on
    // the token and dropping the guesses would answer 200 to a caller whose log was never
    // stored, which is the one failure this route must not fake.
    const response = await handler(wordEvent({ turnstileToken: 'ok', guesses: ['mer'] }));
    expect(response.statusCode).toBe(400);
  });

  it('is what a second device RESUMES: the read carries the same start', async () => {
    const handler = makeHandler();
    await handler(wordEvent({ turnstileToken: 'ok' }));
    handler.advance(20_000);
    const read = await handler(wordEvent());
    expect(read.statusCode).toBe(200);
    expect(parsed(read).startedAt).toBe(START.toISOString());
    // 20s elapsed on the server's own clock, whatever the second device's says.
    expect(Date.parse(parsed(read).now) - Date.parse(parsed(read).startedAt!)).toBe(20_000);
  });
});

describe('word mode: the end-of-run submission (#202)', () => {
  const FLOOR_ONE_CLAIM = wordRunFloorMs(1);

  async function started(options: { word?: WordPuzzle | null } = {}) {
    const handler = makeHandler({ word: options.word === undefined ? WORD_ARTIFACT : options.word });
    await handler(wordEvent({ turnstileToken: 'ok' }));
    return handler;
  }

  it('records the whole log at once, once the run could possibly be over', async () => {
    const handler = await started();
    handler.advance(FLOOR_ONE_CLAIM);
    const response = await handler(wordEvent({ guesses: ['mer', 'loin'] }));
    expect(response.statusCode).toBe(200);
    expect(parsed(response).guesses).toEqual(['mer', 'loin']);
    // And it is what a device that never played the day reads back.
    const read = await handler(wordEvent());
    expect(parsed(read).guesses).toEqual(['mer', 'loin']);
  });

  it('refuses a run that cannot be over yet — the game’s own floor', async () => {
    const handler = await started();
    handler.advance(FLOOR_ONE_CLAIM - 1);
    const response = await handler(wordEvent({ guesses: ['mer'] }));
    expect(response.statusCode).toBe(409);
    expect(parsed(response).error).toBe('too_early');
    // Nothing was stored, and the refusal still answers with the truth.
    expect(parsed(response).guesses).toEqual([]);
    expect(parsed(response).startedAt).toBe(START.toISOString());
  });

  it('prices the floor from the CLAIMS, not from the log’s length', async () => {
    const handler = await started();
    // Three claims need three rungs more than one does; a log of misses needs none of it.
    handler.advance(wordRunFloorMs(3) - 1);
    const early = await handler(wordEvent({ guesses: ['mer', 'ocean', 'bateau'] }));
    expect(parsed(early).error).toBe('too_early');
    const misses = await handler(wordEvent({ guesses: ['loin'] }));
    expect(misses.statusCode).toBe(200);
  });

  it('is FIRST-WRITE-WINS: the daily is one-shot and cannot be replayed', async () => {
    const handler = await started();
    handler.advance(wordRunFloorMs(2));
    await handler(wordEvent({ guesses: ['mer', 'ocean'] }));
    const again = await handler(wordEvent({ guesses: ['mer', 'ocean', 'bateau'] }));
    // Answered, not refused — a retry after a lost response must not look like an error —
    // but the recorded run is the one that landed first.
    expect(again.statusCode).toBe(200);
    expect(parsed(again).guesses).toEqual(['mer', 'ocean']);
  });

  it('refuses a run nobody started here', async () => {
    const handler = makeHandler({ word: WORD_ARTIFACT });
    const response = await handler(wordEvent({ guesses: ['mer'] }));
    expect(response.statusCode).toBe(409);
    expect(parsed(response).error).toBe('not_started');
  });

  it('accepts an EMPTY log: a run that claimed nothing still ended', async () => {
    const handler = await started();
    handler.advance(wordRunFloorMs(0));
    const response = await handler(wordEvent({ guesses: [] }));
    expect(response.statusCode).toBe(200);
    expect(parsed(response).guesses).toEqual([]);
  });

  it('refuses more claims than the ARTIFACT holds', async () => {
    const handler = await started();
    handler.advance(wordRunFloorMs(4));
    // Four entries, but only three claimable groups exist on this board — so at least one
    // of them was invented. (Aliases would repeat a rank, which counts once.)
    const response = await handler(
      wordEvent({ guesses: ['mer', 'ocean', 'bateau', 'phare'] }),
    );
    // `phare` is rank 0 — free, never a claim — so this one is legal; the count is 3.
    expect(response.statusCode).toBe(200);
  });

  it(`refuses more than ${WORD_MISS_CAP} misses`, async () => {
    const handler = await started();
    handler.advance(wordRunFloorMs(0));
    const misses = Array.from({ length: WORD_MISS_CAP + 1 }, (_, i) =>
      `${String.fromCharCode(97 + Math.floor(i / 26) % 26)}${String.fromCharCode(97 + (i % 26))}z`,
    );
    const response = await handler(wordEvent({ guesses: misses }));
    expect(response.statusCode).toBe(400);
  });

  it('validates every guess as a folded slug, like the sentence stream', async () => {
    const handler = await started();
    handler.advance(wordRunFloorMs(0));
    const response = await handler(wordEvent({ guesses: ['Été'] }));
    expect(response.statusCode).toBe(400);
  });

  it('answers the day-addressed 404 when no artifact was published', async () => {
    const handler = await started({ word: null });
    handler.advance(wordRunFloorMs(0));
    const response = await handler(wordEvent({ guesses: ['mer'] }));
    expect(response.statusCode).toBe(404);
  });
});
