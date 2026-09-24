// CONTRACT (#201): /round is the server-authoritative guess log — POST-only (the token
// is the auth and travels in the body), addressed per (date, lang) by the shared
// guard pair, storing the RAW ordered log as strings with no interpretation. The read
// answers the stored round (404 = none yet); the append validates every guess (folded
// slug shape, the language's own max length from #200), enforces the 500-guess cap and
// the ~1s per-player write interval in ONE atomic decision, and EVERY answer — the
// refusals included — carries the full state so a write is also a reconciliation.
// Archive days sync like today's, and a re-published daily restarts the log rather than
// handing back the retired puzzle's.
//
// CONTRACT (#203): the score stops being something the client claims. Every
// append reads the day's DERIVATION SLICE, derives `progress` and `solved` from (the
// stored log + the batch) and writes them in the SAME mutation; it verifies against the
// log the append returned and corrects it when they disagree; a SOLVED round is frozen and
// refuses further appends; the append that solves a round records the day's score row from
// the FULL artifact (unique tries by `guessKey`); and round CREATION is Turnstile-gated,
// since that is where a caller who has done nothing yet mints state.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dayNumber,
  EARLY_GUESS_CAP,
  ROUND_GUESS_CAP,
  ROUND_WRITE_MIN_MS,
  type Puzzle,
} from '@whippin/shared';
import { createHandler } from './handler';
import { memoryHistoryStore } from './memoryHistoryStore';
import { memoryDeviceStore } from './memoryDeviceStore';
import { memoryRoundStore } from './memoryRoundStore';
import { memoryScoreStore } from './memoryScoreStore';
import { buildSlice } from './slice';
import type { PlayerHistoryStore } from './historyStore';
import type { ScoreStore } from './scoreStore';
import type { RoundStore } from './roundStore';
import type { FnUrlEvent } from './respond';
import type { PuzzleStore } from './store';
import { deviceSeed, newTestDevice, seedDevice } from './testDevice';

const START = new Date('2026-08-21T14:00:00Z');
const ACTIVE_DATE = '2026-08-21';
const PAST_DATE = '2026-08-19';
// The day before the active one — the 22:00 flip-edge's date, and an archive replay of
// yesterday's date, which are the same thing to a server (#211).
const YESTERDAY_DATE = '2026-08-20';
const FUTURE_DATE = '2026-08-23';
const ORIGIN = 'https://whippin.example';
// The caller's identity is a STORED pair since #216: one device on one account, seeded
// into the memory store every handler here is built over.
const ME = newTestDevice();
const TOKEN = ME.token;

// The day's SENTENCE puzzle: two holes, each starting two ranks out, so a log can be
// walked from 0% to solved and every rank the derivation reads is inside the slice.
const SENTENCE: Puzzle = {
  lang: 'fr',
  revision: 'a1b2c3d4e5f60718',
  words: ['le', 'phare', 'de', 'nuit'],
  holes: [
    { pos: 1, secret: { word: 'phare', slug: 'phare' }, start: { word: 'quai', slug: 'quai' }, start_rank: 2 },
    { pos: 3, secret: { word: 'nuit', slug: 'nuit' }, start: { word: 'soir', slug: 'soir' }, start_rank: 2 },
  ],
  ranks: {
    phare: {
      phare: { word: 'phare', rank: 0 },
      mer: { word: 'mer', rank: 1, dq: 255 },
      quai: { word: 'quai', rank: 2, dq: 128 },
      loin: { word: 'loin', rank: 9, dq: 0 },
    },
    nuit: {
      nuit: { word: 'nuit', rank: 0 },
      lune: { word: 'lune', rank: 1, dq: 255 },
      soir: { word: 'soir', rank: 2, dq: 128 },
      loin: { word: 'loin', rank: 7, dq: 0 },
    },
  },
};

// The CORRECTED daily a republish puts in the store's place: different holes, so a
// different revision tag — which is what a client sees change, and what the artifacts have
// to be selected by.
const CORRECTED: Puzzle = {
  ...SENTENCE,
  // A REPUBLISH is a new version, whatever changed — here the sentence, but a corrected
  // rank map would be one too, which is the whole point of the stamp (#203).
  revision: 'b2c3d4e5f6071829',
  words: ['la', 'lampe', 'de', 'nuit'],
  holes: [
    { pos: 1, secret: { word: 'phare', slug: 'phare' }, start: { word: 'quai', slug: 'quai' }, start_rank: 2 },
  ],
};

// Every round names the published VERSION it is playing (#203), and the store's two objects
// carry the same one — so these are the real values, not invented strings.
const PUZZLE = SENTENCE.revision;
const CORRECTED_TAG = CORRECTED.revision;

// `null` = the daily was never published. The SLICE is derived from the same puzzle, exactly
// as `puzzle:publish` does, and `sentence` is a HOLDER so a test can republish under a live
// handler.
function puzzleStore(
  sentence: { current: Puzzle | null },
  fullReadFails = false,
): PuzzleStore {
  return {
    async getPuzzle() {
      // The store contract swallows only NotFound — a throttle or a transient 5xx THROWS.
      if (fullReadFails) throw new Error('S3 throttled');
      return sentence.current;
    },
    async getSlice() {
      return sentence.current ? buildSlice(sentence.current) : null;
    },
  };
}

// One handler per test, over ONE memory store, driven by an advancing clock: sequences
// of writes must land on the same record, and the interval needs real time movement.
function makeHandler(
  options: {
    sentence?: Puzzle | null;
    turnstile?: boolean;
    scoreStore?: ScoreStore;
    roundStore?: RoundStore;
    historyStore?: PlayerHistoryStore;
    fullReadFails?: boolean;
  } = {},
) {
  let current = START.getTime();
  const devices = memoryDeviceStore([deviceSeed(ME)]);
  const scoreStore = options.scoreStore ?? memoryScoreStore(() => new Date(current));
  const historyStore = options.historyStore ?? memoryHistoryStore();
  const sentence = { current: options.sentence === undefined ? SENTENCE : options.sentence };
  const handler = createHandler({
    store: puzzleStore(sentence, options.fullReadFails),
    now: () => new Date(current),
    allowedOrigin: ORIGIN,
    deviceStore: devices,
    devices: {
      turnstile: { async verify() { return options.turnstile !== false; } },
      allowSourceIp: true,
    },
    rounds: {
      roundStore: options.roundStore ?? memoryRoundStore(),
      scoreStore,
      ipHmacSecret: 'x'.repeat(64),
      turnstile: { async verify() { return options.turnstile !== false; } },
      history: historyStore,
      allowSourceIp: true,
    },
  });
  return Object.assign(handler, {
    scoreStore,
    historyStore,
    devices,
    advance(ms: number) {
      current += ms;
    },
    // A republish under a LIVE handler. Artifact reads are fresh, so later requests must see
    // the new revision without resetting any process-local state.
    republish(puzzle: Puzzle) {
      sentence.current = puzzle;
    },
  });
}

// Every call carries the player key AND the tag naming which puzzle the log belongs to.
// An APPEND also carries the round-start challenge (#203): the route only verifies it on
// the write that CREATES the record, so sending it on every append is what a client does.
// A READ must NOT carry one — a bare token names no write and is refused.
function body(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const writing = Object.hasOwn(extra, 'guesses');
  return { token: TOKEN, puzzle: PUZZLE, ...(writing ? { turnstileToken: 'tok' } : {}), ...extra };
}

function event(options: {
  method?: string;
  query?: Record<string, string>;
  body?: unknown;
} = {}): FnUrlEvent {
  return {
    rawPath: '/round',
    queryStringParameters:
      options.query ?? { lang: 'fr', date: ACTIVE_DATE },
    requestContext: { http: { method: options.method ?? 'POST', sourceIp: '127.0.0.1' } },
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(options.body === undefined ? body() : options.body),
  };
}

interface RoundResponse {
  guesses: string[];
  createdAt: string;
  progress?: number;
  solved?: boolean;
  credited?: boolean;
  error?: string;
}

function parsed(response: { body: string }): RoundResponse {
  return JSON.parse(response.body) as RoundResponse;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
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
    [{ date: ACTIVE_DATE }, 'missing lang'],
    [{ lang: 'de', date: ACTIVE_DATE }, 'unsupported lang'],
    [{ lang: 'fr' }, 'missing date'],
    [{ lang: 'fr', date: 'not-a-date' }, 'malformed date'],
  ] as [Record<string, string>, string][])('refuses %s (%s)', async (query) => {
    const response = await makeHandler()(event({ query }));
    expect(response.statusCode).toBe(400);
  });

  it('serves no day beyond the +1 future-skew window', async () => {
    const response = await makeHandler()(
      event({ query: { lang: 'fr', date: FUTURE_DATE } }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('refuses a malformed player key', async () => {
    const response = await makeHandler()(event({ body: { token: 'nope', puzzle: PUZZLE } }));
    expect(response.statusCode).toBe(400);
  });

  it.each([
    [undefined, 'missing'],
    ['', 'empty'],
    ['NOT-A-TAG', 'wrong charset'],
    ['a'.repeat(33), 'over-long'],
  ] as [unknown, string][])('refuses a %s puzzle tag (%s)', async (puzzle) => {
    const response = await makeHandler()(event({ body: { token: TOKEN, puzzle } }));
    expect(response.statusCode).toBe(400);
  });

  it("never reads the puzzle store — archive days sync like today's", async () => {
    const response = await makeHandler()(
      event({ query: { lang: 'fr', date: PAST_DATE }, body: body() }),
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

    // The same (date, lang) key, a different sentence under it. The client reset
    // its local round on exactly this change; handing back the old log would undo that.
    const read = await handler(event({ body: { token: TOKEN, puzzle: 'deadbeef' } }));
    expect(read.statusCode).toBe(404);
  });

  it('REPLACES the retired log on the next append instead of growing it', async () => {
    const handler = makeHandler();
    await handler(event({ body: body({ guesses: ['ancien'] }) }));
    handler.advance(ROUND_WRITE_MIN_MS + 1);

    handler.republish(CORRECTED);
    const restarted = await handler(
      event({ body: { token: TOKEN, puzzle: CORRECTED_TAG, guesses: ['mer'], turnstileToken: 'tok' } }),
    );
    expect(restarted.statusCode).toBe(200);
    expect(parsed(restarted).guesses).toEqual(['mer']);

    // And the new tag is what the record now answers to.
    handler.advance(ROUND_WRITE_MIN_MS + 1);
    const read = await handler(event({ body: { token: TOKEN, puzzle: CORRECTED_TAG } }));
    expect(parsed(read).guesses).toEqual(['mer']);
  });

  it('never hands the retired log back on a rate-refused restart', async () => {
    const handler = makeHandler();
    await handler(event({ body: body({ guesses: ['ancien'] }) }));

    // The corrected puzzle's first flush lands INSIDE the write interval. Every answer,
    // refusals included, is adopted by the client as this round's truth — so a 429
    // carrying the retired sentence's log would reintroduce exactly the guesses the tag
    // exists to exclude.
    handler.republish(CORRECTED);
    const refused = await handler(
      event({ body: { token: TOKEN, puzzle: CORRECTED_TAG, guesses: ['mer'], turnstileToken: 'tok' } }),
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
        query: { lang: 'fr', date: PAST_DATE },
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

describe('identity (#216)', () => {
  it('keys rounds by the ACCOUNT a device resolves to — another account is another round', async () => {
    const handler = makeHandler();
    await handler(event({ body: body({ guesses: ['bois'] }) }));
    const stranger = await seedDevice(handler.devices);
    const other = await handler(event({ body: { token: stranger.token, puzzle: PUZZLE } }));
    expect(other.statusCode).toBe(404);
  });

  it('two DEVICES on one account play the SAME round — that is the whole point', async () => {
    const handler = makeHandler();
    await handler(event({ body: body({ guesses: ['bois'] }) }));
    // A second device signed into the same account: the round is the account's, so the
    // laptop reads what the phone typed.
    const laptop = await seedDevice(handler.devices, { accountId: ME.accountId });
    const read = await handler(event({ body: { token: laptop.token, puzzle: PUZZLE } }));
    expect(read.statusCode).toBe(200);
    expect(JSON.parse(read.body).guesses).toEqual(['bois']);
  });

  it('answers a well-formed token nobody holds with unknown_device, never a fresh round', async () => {
    const handler = makeHandler();
    // The distinct, unambiguous answer the client turns into its signed-out screen — and
    // NEVER a silent new identity, which is what would let a revoked device play on.
    const response = await handler(
      event({ body: { token: 'f'.repeat(64), puzzle: PUZZLE, guesses: ['bois'], turnstileToken: 'tok' } }),
    );
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error).toBe('unknown_device');
  });
});

// CONTRACT (#203): the server DERIVES what it used to be told.
describe('the derived summary (#203)', () => {
  // `SENTENCE`'s two holes both start at rank 2; typing a secret solves its own hole.
  const solvedKey = { date: ACTIVE_DATE, lang: 'fr' };

  async function appendGuesses(handler: ReturnType<typeof makeHandler>, ...batches: string[][]) {
    let last = await handler(event({ body: body({ guesses: batches[0] }) }));
    for (const batch of batches.slice(1)) {
      handler.advance(ROUND_WRITE_MIN_MS + 1);
      last = await handler(event({ body: body({ guesses: batch }) }));
    }
    return last;
  }

  it('writes progress and solved BESIDE the guesses, in the same answer', async () => {
    const handler = makeHandler();
    const first = parsed(await appendGuesses(handler, ['mer']));
    // One hole moved from rank 2 to rank 1, the other is untouched: real progress, and
    // nothing solved.
    expect(first.progress).toBeGreaterThan(0);
    expect(first.progress).toBeLessThan(100);
    expect(first.solved).toBeUndefined();
  });

  it('reads a guess the slice does not hold as no progress at all', async () => {
    const handler = makeHandler();
    const answer = parsed(await appendGuesses(handler, ['zzz']));
    expect(answer.progress).toBe(0);
    expect(answer.guesses).toEqual(['zzz']);
  });

  it('marks the round SOLVED once every secret is typed, and records the day\'s score', async () => {
    const handler = makeHandler();
    const answer = parsed(await appendGuesses(handler, ['mer'], ['phare', 'nuit']));
    expect(answer.solved).toBe(true);
    expect(answer.progress).toBeCloseTo(100, 10);
    // The confirming answer also says the day was EARNED: the client's celebration rides
    // this flag instead of re-making the on-time comparison on its own clock.
    expect(answer.credited).toBe(true);

    // The score is DERIVED from the stored log by the counted-try identity — three
    // distinct guesses here — and written by the append that solved the round, so the
    // population already holds it by the time the client can read a standing.
    const rows = await handler.scoreStore.list(solvedKey);
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(3);
    expect(rows[0].publicId).toBe(ME.accountId);
  });

  // #211: the same append that records the score credits the STREAK's day. ON TIME means ON
  // THE DAY (user-decided 2026-08-23) — the round's day must BE the server's active day, so
  // an archive replay credits nothing at any distance and a round carried past the 22:00
  // flip credits nothing either. The credit is a set insert, so a corrected revision solved
  // again cannot claim the day twice.
  it('credits the streak day when the ACTIVE day is solved', async () => {
    const handler = makeHandler();
    expect(parsed(await appendGuesses(handler, ['phare', 'nuit'])).solved).toBe(true);
    const me = ME.accountId;
    await expect(handler.historyStore.solvedDays(me, 'fr')).resolves.toEqual([
      dayNumber(ACTIVE_DATE),
    ]);
  });

  // `credited` is the credit's OUTCOME, not merely the on-time verdict: the client
  // celebrates the streak and transiently holds the day off this flag, so an on-time solve
  // whose collection write FAILED must answer false — a day held on a write that failed is
  // a phantom the union merge can never remove, and the freeze means no later append will
  // ever re-ask. The solve itself, the log and the score row are unaffected: the collection
  // is a rebuildable cache, and its failure is silent to the append.
  it('answers credited: false when the streak credit could not be recorded', async () => {
    const failing = memoryHistoryStore();
    failing.recordSolvedDay = async () => {
      throw new Error('provisioned throughput exceeded');
    };
    const handler = makeHandler({ historyStore: failing });
    const answer = parsed(await appendGuesses(handler, ['phare', 'nuit']));
    expect(answer.solved).toBe(true);
    expect(answer.credited).toBe(false);
    // The score row is INDEPENDENT of the credit and still records: a missing standing is
    // its own silent failure mode, never a reason to withhold the day's leaderboard entry.
    await expect(handler.scoreStore.list(solvedKey)).resolves.toHaveLength(1);
  });

  // The score's artifact read is the one line in the solve's rewards that can THROW (the
  // store only swallows NotFound — a throttle or a transient S3 5xx rethrows). By then the
  // append has already committed and FROZEN the round, so an escaping throw would 500 a
  // solve that stands — and the freeze means no later append would ever retry the row.
  it('still answers the solve when the scoring artifact cannot be READ', async () => {
    const handler = makeHandler({ fullReadFails: true });
    const answer = parsed(await appendGuesses(handler, ['phare', 'nuit']));
    expect(answer.solved).toBe(true);
    // The two rewards are independent: the streak credit still lands...
    expect(answer.credited).toBe(true);
    // ...while the population is simply missing this standing — the silent failure mode.
    await expect(handler.scoreStore.list(solvedKey)).resolves.toHaveLength(0);
  });

  // LATE HAS NO GRADATIONS (user-decided 2026-08-23): a millisecond late is a decade late,
  // and neither earns the day's rewards — not the streak credit, not the leaderboard row.
  it.each([
    ['an ARCHIVE solve', PAST_DATE],
    // YESTERDAY is the case that used to be tolerated, for the 22:00 flip-edge. It reads
    // here exactly as it reads for a deliberate archive replay of yesterday — which is why
    // the tolerance could never be applied honestly server-side, and why it is gone.
    ['a solve carried past the 22:00 flip', YESTERDAY_DATE],
  ])('%s earns NOTHING the day gives', async (_name, date) => {
    const handler = makeHandler();
    const late = await handler(
      event({
        query: { lang: 'fr', date },
        body: body({ guesses: ['phare', 'nuit'] }),
      }),
    );
    // It really solved, and the LOG is stored either way — what is being pinned is the
    // RULE, not a failed derivation or a refused append.
    expect(parsed(late).solved).toBe(true);
    expect(parsed(late).guesses).toEqual(['phare', 'nuit']);
    // And the answer SAYS nothing was earned, so no client can celebrate a day the server
    // refused off its own faster clock.
    expect(parsed(late).credited).toBe(false);

    const me = ME.accountId;
    await expect(handler.historyStore.solvedDays(me, 'fr')).resolves.toEqual([]);
    // No leaderboard row either: a board is a day's competition, and this finished after
    // that day ended. The solved screen then draws no standing at all (`bucket: null`).
    expect(await handler.scoreStore.list({ date, lang: 'fr' })).toEqual([]);
  });

  it('solving a CORRECTED revision cannot claim the same day twice', async () => {
    const handler = makeHandler();
    await appendGuesses(handler, ['phare', 'nuit']);
    handler.republish(CORRECTED);
    handler.advance(ROUND_WRITE_MIN_MS + 1);
    // The retired round restarts under the same key; the corrected sentence's one hole is
    // solved by typing its secret.
    const again = await handler(
      event({ body: body({ puzzle: CORRECTED_TAG, guesses: ['phare'] }) }),
    );
    expect(parsed(again).solved).toBe(true);
    const me = ME.accountId;
    await expect(handler.historyStore.solvedDays(me, 'fr')).resolves.toEqual([
      dayNumber(ACTIVE_DATE),
    ]);
  });

  it('counts UNIQUE tries: two surfaces of one group are one try', async () => {
    // `loin` is the same GROUP in neither map, but it IS one identity typed twice.
    const handler = makeHandler();
    await appendGuesses(handler, ['loin'], ['loin', 'mer'], ['phare', 'nuit']);
    const rows = await handler.scoreStore.list(solvedKey);
    // loin, mer, phare, nuit — the repeat does not count twice.
    expect(rows[0].score).toBe(4);
  });

  it('FREEZES a solved round: further appends are refused and nothing is stored', async () => {
    const handler = makeHandler();
    await appendGuesses(handler, ['phare', 'nuit']);
    handler.advance(ROUND_WRITE_MIN_MS + 1);

    const refused = await handler(event({ body: body({ guesses: ['mer'] }) }));
    expect(refused.statusCode).toBe(409);
    expect(parsed(refused).error).toBe('round_solved');
    // The refusal is an ANSWER: it carries the stored state, so the tab that sent it
    // renders the round solved instead of an unsolved board with its guesses on screen.
    expect(parsed(refused).guesses).toEqual(['phare', 'nuit']);
    expect(parsed(refused).solved).toBe(true);

    // And a later READ shows the log unchanged — the refused batch is dropped for good.
    handler.advance(ROUND_WRITE_MIN_MS + 1);
    expect(parsed(await handler(event())).guesses).toEqual(['phare', 'nuit']);
  });

  it('records the score ONCE, however many appends follow', async () => {
    const handler = makeHandler();
    await appendGuesses(handler, ['phare', 'nuit']);
    handler.advance(ROUND_WRITE_MIN_MS + 1);
    await handler(event({ body: body({ guesses: ['mer'] }) })); // refused by the freeze
    const rows = await handler.scoreStore.list(solvedKey);
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(2);
  });

  it('a RESTARTED round loses the retired puzzle\'s solve rather than staying frozen', async () => {
    const handler = makeHandler();
    await appendGuesses(handler, ['phare', 'nuit']);
    handler.advance(ROUND_WRITE_MIN_MS + 1);

    // The daily is re-published: the record names a retired sentence, so the batch
    // REPLACES the log — and the freeze must go with it, or the corrected puzzle would be
    // unplayable for everyone who had solved the retired one.
    handler.republish(CORRECTED);
    const restarted = await handler(
      event({ body: { token: TOKEN, puzzle: CORRECTED_TAG, guesses: ['mer'], turnstileToken: 'tok' } }),
    );
    expect(restarted.statusCode).toBe(200);
    expect(parsed(restarted).solved).toBeUndefined();
    expect(parsed(restarted).guesses).toEqual(['mer']);
  });

  it('answers the day-addressed 404 when the slice is missing — there is no degraded mode', async () => {
    const handler = makeHandler({ sentence: null });
    const response = await handler(event({ body: body({ guesses: ['mer'] }) }));
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error).toBe('not_found');
  });

  it('a READ needs no slice and derives nothing', async () => {
    // The mount read is the player's own state, not a population claim — it must stay
    // cheap, and it must work on a day whose slice is missing.
    const handler = makeHandler({ sentence: null });
    expect((await handler(event())).statusCode).toBe(404); // nothing stored, not a slice 404
  });
});

// CONTRACT (#203): ROUND START is Turnstile-gated. Round creation is
// available to every unlinked visitor, so it carries the challenge the retired score POST
// used to — and only round CREATION does: a later append to a record that already exists
// costs nothing.
describe('the round-start challenge (#203)', () => {
  it('refuses to CREATE a round without a challenge', async () => {
    const handler = makeHandler();
    const response = await handler(
      event({ body: { token: TOKEN, puzzle: PUZZLE, guesses: ['mer'] } }),
    );
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error).toBe('turnstile_rejected');

    // Nothing was stored: the refusal comes before the write.
    const read = await handler(event());
    expect(read.statusCode).toBe(404);
  });

  it('refuses a challenge the verifier rejects', async () => {
    const handler = makeHandler({ turnstile: false });
    const response = await handler(event({ body: body({ guesses: ['mer'] }) }));
    expect(response.statusCode).toBe(403);
  });

  it('asks ONCE: an append to an existing round needs no challenge', async () => {
    const handler = makeHandler();
    expect((await handler(event({ body: body({ guesses: ['mer'] }) }))).statusCode).toBe(200);
    handler.advance(ROUND_WRITE_MIN_MS + 1);
    const second = await handler(
      event({ body: { token: TOKEN, puzzle: PUZZLE, guesses: ['quai'] } }),
    );
    expect(second.statusCode).toBe(200);
    expect(parsed(second).guesses).toEqual(['mer', 'quai']);
  });

  it('refuses a bare token — it names no write', async () => {
    const handler = makeHandler();
    const response = await handler(
      event({ body: { token: TOKEN, puzzle: PUZZLE, turnstileToken: 'tok' } }),
    );
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe('bad_request');
  });
});

// CONTRACT (#203, added on review): an outcome this route CLAIMS has to be one the store
// actually holds, and an eventually-consistent read is never evidence of absence.
describe('what the answer is allowed to claim (#203)', () => {
  const solvedKey = { date: ACTIVE_DATE, lang: 'fr' };

  it('does NOT report a solve whose corrective write never landed', async () => {
    // The rare race (the append derived unsolved, the returned log is solved) meeting three
    // consecutive write failures. This used to answer `solved: true`, record a score and
    // close the client's conversation over a row DynamoDB still reads as unsolved.
    const store = memoryRoundStore();
    const inner = store.append.bind(store);
    const handler = makeHandler({
      roundStore: {
        ...store,
        // Land the guesses, but write the summary as though the caller had derived nothing —
        // which is what a stale pre-read produces.
        append: (input) => inner({ ...input, progress: 0, solved: false }),
        async settle() {
          throw new Error('ProvisionedThroughputExceeded');
        },
      },
    });

    const answer = await handler(event({ body: body({ guesses: ['phare', 'nuit'] }) }));
    expect(answer.statusCode).toBe(200);
    // The guesses ARE stored — that write committed.
    expect(parsed(answer).guesses).toEqual(['phare', 'nuit']);
    // But nothing claims a solve the store does not hold, so the client keeps its
    // conversation open rather than closing on a freeze that is not there…
    expect(parsed(answer).solved).toBeUndefined();
    // …and no score row is recorded beside a round row that reads unsolved.
    expect(await handler.scoreStore.list(solvedKey)).toEqual([]);
  });

  it('CONFIRMS a missing round consistently before demanding a challenge', async () => {
    // The pre-read is eventually consistent, so its `null` is not evidence. A stale one
    // demands a token the client only ever sends on the append it believes creates the
    // round — so the write is 403'd, which the client reads as a VERDICT and closes on.
    const store = memoryRoundStore();
    const handler = makeHandler({
      roundStore: {
        ...store,
        get: (key, publicId, puzzle, opts) =>
          // Exactly the failure mode: the fast read is blind, the consistent one is not.
          opts?.consistent === false ? Promise.resolve(null) : store.get(key, publicId, puzzle),
      },
    });

    expect((await handler(event({ body: body({ guesses: ['mer'] }) }))).statusCode).toBe(200);
    handler.advance(ROUND_WRITE_MIN_MS + 1);
    // The client believes the round exists and sends no challenge — correctly.
    const second = await handler(
      event({ body: { token: TOKEN, puzzle: PUZZLE, guesses: ['quai'] } }),
    );
    expect(second.statusCode).toBe(200);
    expect(parsed(second).guesses).toEqual(['mer', 'quai']);
  });
});

// CONTRACT (#203, added on review): a corrective write that is DECLINED is not a write that
// landed. A concurrent republish makes the record name another puzzle, the store's condition
// refuses, and swallowing that as success claimed a solve the record never took — recording
// a score row beside it.
describe('a declined corrective write is not a solve (#203)', () => {
  it('does not claim a solve the store refused, and records no score', async () => {
    const store = memoryRoundStore();
    const inner = store.append.bind(store);
    const handler = makeHandler({
      roundStore: {
        ...store,
        // The append stores the guesses but derives nothing — the stale-pre-read shape that
        // makes a corrective write necessary at all.
        append: (input) => inner({ ...input, progress: 0, solved: false }),
        // …and the record has moved on under us, so the condition declines.
        async settle() {
          return false;
        },
      },
    });

    const answer = await handler(event({ body: body({ guesses: ['phare', 'nuit'] }) }));
    expect(answer.statusCode).toBe(200);
    expect(parsed(answer).guesses).toEqual(['phare', 'nuit']);
    expect(parsed(answer).solved).toBeUndefined();
    expect(await handler.scoreStore.list({ date: ACTIVE_DATE, lang: 'fr' })).toEqual(
      [],
    );
  });
});

// CONTRACT (#273, user-decided 2026-09-08): TOMORROW'S sentence opens TONIGHT, on the +1-day
// window the route already serves, and the night's play stops at the FIRST PROGRESS or after
// EARLY_GUESS_CAP guesses, whichever comes first. The server enforces both inside the
// append's own condition: for a round whose date is AFTER the server's active day an append
// is accepted only while the stored `progress` is 0 and the resulting log stays within the
// cap; the guess that makes progress is STORED (it is what moves `progress`) and the next
// append is refused 409 `early_locked`. A hit is progress, so an early SOLVE cannot happen.
describe('early play: tomorrow\'s sentence tonight (#273)', () => {
  const TOMORROW_DATE = '2026-08-22';
  const TOMORROW_QUERY = { lang: 'fr', date: TOMORROW_DATE };
  const tomorrow = (guesses?: string[]) =>
    event({ query: TOMORROW_QUERY, body: body(guesses ? { guesses } : {}) });

  async function play(handler: ReturnType<typeof makeHandler>, ...batches: string[][]) {
    let last = await handler(tomorrow(batches[0]));
    for (const batch of batches.slice(1)) {
      handler.advance(ROUND_WRITE_MIN_MS + 1);
      last = await handler(tomorrow(batch));
    }
    return last;
  }

  it(`accepts guesses that move nothing, ${EARLY_GUESS_CAP} at most, and refuses the next`, async () => {
    const handler = makeHandler();
    const third = await play(handler, ['zzz'], ['yyy'], ['xxx']);
    expect(third.statusCode).toBe(200);
    expect(parsed(third).guesses).toEqual(['zzz', 'yyy', 'xxx']);
    expect(parsed(third).progress).toBe(0);

    handler.advance(ROUND_WRITE_MIN_MS + 1);
    const refused = await handler(tomorrow(['www']));
    expect(refused.statusCode).toBe(409);
    expect(parsed(refused).error).toBe('early_locked');
    // The refusal is an ANSWER: it carries the unchanged stored log the client adopts.
    expect(parsed(refused).guesses).toEqual(['zzz', 'yyy', 'xxx']);
    expect(parsed(await handler(tomorrow())).guesses).toHaveLength(EARLY_GUESS_CAP);
  });

  it('stores the guess that makes progress, and refuses everything after it', async () => {
    const handler = makeHandler();
    // `mer` beats the `phare` hole's start word (rank 1 against a start of 2).
    const hit = await play(handler, ['zzz'], ['mer']);
    expect(hit.statusCode).toBe(200);
    expect(parsed(hit).progress).toBeGreaterThan(0);

    handler.advance(ROUND_WRITE_MIN_MS + 1);
    const refused = await handler(tomorrow(['yyy']));
    expect(refused.statusCode).toBe(409);
    expect(parsed(refused).error).toBe('early_locked');
    expect(parsed(refused).guesses).toEqual(['zzz', 'mer']);
  });

  it('cannot be SOLVED early: the hit is stored, the batch that would finish it is refused', async () => {
    const handler = makeHandler();
    const hit = parsed(await play(handler, ['phare']));
    expect(hit.progress).toBeGreaterThan(0);
    expect(hit.solved).toBeUndefined();

    handler.advance(ROUND_WRITE_MIN_MS + 1);
    const refused = await handler(tomorrow(['nuit']));
    expect(parsed(refused).error).toBe('early_locked');
    expect(parsed(refused).solved).toBeUndefined();
    // So the on-time rule never has to deny an early round anything: no row, no day.
    await expect(
      handler.scoreStore.list({ date: TOMORROW_DATE, lang: 'fr' }),
    ).resolves.toHaveLength(0);
    await expect(handler.historyStore.solvedDays(ME.accountId, 'fr')).resolves.toEqual([]);
  });

  it('refuses a three-secret batch without freezing an early solve', async () => {
    const sentence: Puzzle = {
      ...SENTENCE,
      words: [...SENTENCE.words, 'mer'],
      holes: [...SENTENCE.holes, {
        pos: 4, secret: { word: 'mer', slug: 'mer' },
        start: { word: 'eau', slug: 'eau' }, start_rank: 1,
      }],
      ranks: { ...SENTENCE.ranks, mer: {
        mer: { word: 'mer', rank: 0 }, eau: { word: 'eau', rank: 1, dq: 255 },
      } },
    };
    const handler = makeHandler({ sentence });
    const refused = await handler(tomorrow(['phare', 'nuit', 'mer']));
    expect(refused.statusCode).toBe(409);
    expect(parsed(refused).error).toBe('early_locked');
    expect(parsed(refused).guesses).toEqual([]);
    expect((await handler(tomorrow())).statusCode).toBe(404);

    // A valid retry remains playable and can earn the day after the flip.
    expect((await handler(tomorrow(['phare']))).statusCode).toBe(200);
    handler.advance(24 * 60 * 60 * 1000);
    expect(parsed(await handler(tomorrow(['nuit', 'mer']))).credited).toBe(true);
  });

  it('accepts a batch ending at its first improvement, but nothing after it', async () => {
    const handler = makeHandler();
    const accepted = await handler(tomorrow(['zzz', 'mer']));
    expect(accepted.statusCode).toBe(200);
    expect(parsed(accepted).guesses).toEqual(['zzz', 'mer']);
    handler.advance(ROUND_WRITE_MIN_MS + 1);
    expect(parsed(await handler(tomorrow(['yyy']))).error).toBe('early_locked');
  });

  it('refuses a batch with an improvement before its end without partially appending', async () => {
    const handler = makeHandler();
    await handler(tomorrow(['zzz']));
    handler.advance(ROUND_WRITE_MIN_MS + 1);
    const refused = await handler(tomorrow(['mer', 'yyy']));
    expect(refused.statusCode).toBe(409);
    expect(parsed(refused).guesses).toEqual(['zzz']);
    expect(parsed(await handler(tomorrow())).guesses).toEqual(['zzz']);
  });

  it('bounds the RESULTING log: a first batch past the cap creates nothing', async () => {
    const handler = makeHandler();
    const refused = await handler(tomorrow(['a', 'b', 'c', 'd']));
    expect(refused.statusCode).toBe(409);
    expect(parsed(refused).error).toBe('early_locked');
    expect((await handler(tomorrow())).statusCode).toBe(404);
  });

  it('is the early round\'s bound alone — today\'s round plays on past it', async () => {
    const handler = makeHandler();
    const misses = ['zzz', 'yyy', 'xxx', 'www', 'vvv'];
    let last = await handler(event({ body: body({ guesses: [misses[0]] }) }));
    for (const miss of misses.slice(1)) {
      handler.advance(ROUND_WRITE_MIN_MS + 1);
      last = await handler(event({ body: body({ guesses: [miss] }) }));
    }
    expect(last.statusCode).toBe(200);
    expect(parsed(last).guesses).toEqual(misses);
  });

  it('the log STAYS, and the day itself unlocks it — the early guesses count as tries', async () => {
    const handler = makeHandler();
    await play(handler, ['zzz'], ['mer']);
    handler.advance(ROUND_WRITE_MIN_MS + 1);
    expect(parsed(await handler(tomorrow(['yyy']))).error).toBe('early_locked');

    // The flip: a day later the server's active day IS this round's day, and the same
    // append that was refused lands on the same log.
    handler.advance(24 * 60 * 60 * 1000);
    const resumed = await handler(tomorrow(['yyy']));
    expect(resumed.statusCode).toBe(200);
    expect(parsed(resumed).guesses).toEqual(['zzz', 'mer', 'yyy']);

    // …and the solve, ON THE DAY, earns the day like any other: the try count includes
    // the night's guesses.
    handler.advance(ROUND_WRITE_MIN_MS + 1);
    const solved = parsed(await handler(tomorrow(['phare', 'nuit'])));
    expect(solved.solved).toBe(true);
    expect(solved.credited).toBe(true);
    const rows = await handler.scoreStore.list({ date: TOMORROW_DATE, lang: 'fr' });
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(5);
  });
});

// CONTRACT (bonus puzzles, 2026-09-24): a BONUS is a test puzzle outside the calendar,
// addressed by its seven-digit id (shared bonus.ts). Its round is an ordinary server-owned
// log — the same guards, the same derived score — but it is NO DAY: never early (the
// night's lock cannot apply), never on time (no score row, no streak day, `credited`
// false), and its log is its own, apart from every day's.
describe('a bonus round (bonus puzzles)', () => {
  const BONUS_ID = '1234567';
  const bonus = (guesses?: string[]) =>
    event({ query: { lang: 'fr', bonus: BONUS_ID }, body: body(guesses ? { guesses } : {}) });

  it('refuses a malformed bonus id', async () => {
    for (const id of ['123456', '0123456', '12345678', 'abcdefg']) {
      const response = await makeHandler()(event({ query: { lang: 'fr', bonus: id } }));
      expect(response.statusCode).toBe(400);
    }
  });

  it('is never early: progress and guesses past the night cap are accepted', async () => {
    const handler = makeHandler();
    const batches = [['mer'], ...Array.from({ length: EARLY_GUESS_CAP }, (_, i) => [`zz${'z'.repeat(i)}`])];
    let last = await handler(bonus(batches[0]));
    for (const batch of batches.slice(1)) {
      handler.advance(ROUND_WRITE_MIN_MS + 1);
      last = await handler(bonus(batch));
    }
    expect(last.statusCode).toBe(200);
    expect(parsed(last).guesses).toHaveLength(EARLY_GUESS_CAP + 1);
  });

  it('solves like a day but earns nothing: no score row, no streak day', async () => {
    const handler = makeHandler();
    const solved = parsed(await handler(bonus(['phare', 'nuit'])));
    expect(solved.solved).toBe(true);
    expect(solved.credited).toBe(false);
    await expect(handler.scoreStore.list({ date: `bonus/${BONUS_ID}`, lang: 'fr' })).resolves.toEqual([]);
    await expect(handler.scoreStore.list({ date: ACTIVE_DATE, lang: 'fr' })).resolves.toEqual([]);
    await expect(handler.historyStore.solvedDays(ME.accountId, 'fr')).resolves.toEqual([]);
  });

  it('keeps its own log, apart from the day\'s', async () => {
    const handler = makeHandler();
    await handler(bonus(['zzz']));
    expect(parsed(await handler(bonus())).guesses).toEqual(['zzz']);
    expect((await handler(event())).statusCode).toBe(404);
  });
});
