// CONTRACT (#201): /round is the server-authoritative guess log — POST-only (the token
// is the auth and travels in the body), addressed per (date, lang, mode) by the shared
// guard triple, storing the RAW ordered log as strings with no interpretation. The read
// answers the stored round (404 = none yet); the append validates every guess (folded
// slug shape, the language's own max length from #200), enforces the 500-guess cap and
// the ~1s per-player write interval in ONE atomic decision, and EVERY answer — the
// refusals included — carries the full state so a write is also a reconciliation.
// Archive days sync like today's, and a re-published daily restarts the log rather than
// handing back the retired puzzle's.
//
// CONTRACT (#203): the score stops being something the client claims. Every sentence
// append reads the day's DERIVATION SLICE, derives `progress` and `solved` from (the
// stored log + the batch) and writes them in the SAME mutation; it verifies against the
// log the append returned and corrects it when they disagree; a SOLVED round is frozen and
// refuses further appends; the append that solves a round records the day's score row from
// the FULL artifact (unique tries by `guessKey`); and round CREATION is Turnstile-gated in
// both modes, since that is where a caller who has done nothing yet mints state.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dayNumber,
  ROUND_GUESS_CAP,
  ROUND_WRITE_MIN_MS,
  WORD_MISS_CAP,
  wordRunFloorMs,
  type Puzzle,
  type WordPuzzle,
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

// `undefined` = the artifact must never be read on this path; `null` = the daily was never
// published. The SLICE is derived from the same puzzle, exactly as `puzzle:publish` does,
// and `sentence` is a HOLDER so a test can republish under a live handler.
function puzzleStore(
  word: WordPuzzle | null | undefined,
  sentence: { current: Puzzle | null },
  fullReadFails = false,
): PuzzleStore {
  return {
    async getPuzzle() {
      // The store contract swallows only NotFound — a throttle or a transient 5xx THROWS.
      if (fullReadFails) throw new Error('S3 throttled');
      return sentence.current;
    },
    async getWordPuzzle() {
      if (word === undefined) throw new Error('the round route must not read the word artifact');
      return word;
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
    word?: WordPuzzle | null;
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
    store: puzzleStore(options.word, sentence, options.fullReadFails),
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

// A word round's own addressing + tag: everything the two word writes share.
const WORD_QUERY = { lang: 'fr', date: ACTIVE_DATE, mode: 'word' };
const WORD_TAG = 'w0rd';

function wordEvent(extra: Record<string, unknown> = {}, query = WORD_QUERY): FnUrlEvent {
  return event({ query, body: { token: TOKEN, puzzle: WORD_TAG, ...extra } });
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
  // WHICH device the word run belongs to (#217) — the id its two conditions compare, plus
  // the label the screen names that device with.
  startedBy?: { deviceId: string; device: string; os: string; browser: string };
  submittedAt?: string;
  progress?: number;
  solved?: boolean;
  credited?: boolean;
  now: string;
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

  it('stamps the DEVICE the run belongs to, by its own label (#217)', async () => {
    const handler = makeHandler();
    const response = await handler(wordEvent({ turnstileToken: 'ok' }));
    // The id is what the submission is checked against; the parsed user-agent fields are
    // what lets another device name this one before ending its run.
    expect(parsed(response).startedBy).toEqual({
      deviceId: ME.deviceId,
      device: 'Test',
      os: 'Test',
      browser: 'Test',
    });
  });

  it('RESTARTS: every start mints a fresh clock while the run is unsubmitted (#217)', async () => {
    const handler = makeHandler();
    await handler(wordEvent({ turnstileToken: 'ok' }));
    handler.advance(5_000);
    const again = await handler(wordEvent({ turnstileToken: 'ok' }));
    expect(again.statusCode).toBe(200);
    // #202 answered the ORIGINAL stamp here. A run is no longer resumable across a tap:
    // its claims live in the playing device's local storage, so what a second tap can
    // honestly offer is a fresh run, not a clock whose log is unreachable.
    expect(parsed(again).startedAt).toBe(new Date(START.getTime() + 5_000).toISOString());
  });

  it('a RESTART wipes the run it replaces — log and all', async () => {
    const handler = makeHandler({ word: WORD_ARTIFACT });
    await handler(wordEvent({ turnstileToken: 'ok' }));
    handler.advance(wordRunFloorMs(1));
    // A restart on the SAME device: the old clock and everything it was about are gone.
    const restarted = await handler(wordEvent({ turnstileToken: 'ok' }));
    expect(parsed(restarted).guesses).toEqual([]);
    expect(parsed(restarted).submittedAt).toBeUndefined();
  });

  it('refuses to restart a RECORDED run, answering with the final one (#217)', async () => {
    const handler = makeHandler({ word: WORD_ARTIFACT });
    await handler(wordEvent({ turnstileToken: 'ok' }));
    handler.advance(wordRunFloorMs(1));
    await handler(wordEvent({ guesses: ['mer'] }));

    const again = await handler(wordEvent({ turnstileToken: 'ok' }));
    // Once a log is stored the daily is over: the caller adopts the run that stands rather
    // than starting one the recorded score could never belong to.
    expect(again.statusCode).toBe(200);
    expect(parsed(again).guesses).toEqual(['mer']);
    expect(parsed(again).submittedAt).toBeTruthy();
  });

  it('restarts the round when a DIFFERENT word is published under the same key', async () => {
    const handler = makeHandler();
    await handler(wordEvent({ turnstileToken: 'ok' }));
    handler.advance(5_000);
    const restarted = await handler(
      event({ query: WORD_QUERY, body: { token: TOKEN, puzzle: 'other', turnstileToken: 'ok' } }),
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

  it('the READ carries the stamp, so a second device can see WHOSE run it is', async () => {
    const handler = makeHandler();
    await handler(wordEvent({ turnstileToken: 'ok' }));
    handler.advance(20_000);
    const laptop = await seedDevice(handler.devices, { accountId: ME.accountId });
    const read = await handler(
      event({ query: WORD_QUERY, body: { token: laptop.token, puzzle: WORD_TAG } }),
    );
    expect(read.statusCode).toBe(200);
    expect(parsed(read).startedAt).toBe(START.toISOString());
    // The read WRITES nothing: it says the run is the other device's, and the screen picks
    // its phase from that — PLAY, offering to restart, never a clock it cannot see the log
    // of. 20s elapsed on the server's own clock, whatever the second device's says.
    expect(parsed(read).startedBy?.deviceId).toBe(ME.deviceId);
    expect(Date.parse(parsed(read).now) - Date.parse(parsed(read).startedAt!)).toBe(20_000);
  });
});

// CONTRACT (#217): the run belongs to the DEVICE that started it. Two conditions carry the
// whole model — a start is accepted only while the run is unsubmitted (and then always
// mints a fresh stamp), a submission only while the run is unsubmitted AND the stamp names
// the caller. Concurrent devices are deliberately last-commit-wins inside those two.
describe('word mode: the run belongs to a device (#217)', () => {
  async function twoDevices() {
    const handler = makeHandler({ word: WORD_ARTIFACT });
    const laptop = await seedDevice(handler.devices, { accountId: ME.accountId });
    const asLaptop = (extra: Record<string, unknown> = {}) =>
      event({ query: WORD_QUERY, body: { token: laptop.token, puzzle: WORD_TAG, ...extra } });
    return { handler, laptop, asLaptop };
  }

  it('a second device STARTING takes the run, and the first device can no longer submit it', async () => {
    const { handler, laptop, asLaptop } = await twoDevices();
    await handler(wordEvent({ turnstileToken: 'ok' }));
    handler.advance(1_000);
    const stolen = await handler(asLaptop({ turnstileToken: 'ok' }));
    expect(parsed(stolen).startedBy?.deviceId).toBe(laptop.deviceId);

    handler.advance(wordRunFloorMs(1));
    const refused = await handler(wordEvent({ guesses: ['mer'] }));
    // The phone's log describes a clock the server no longer holds. Recording it would bury
    // the run the laptop is playing — permanently, since the submission is first-write-wins.
    expect(refused.statusCode).toBe(409);
    expect(parsed(refused).error).toBe('started_elsewhere');
    // The refusal is a reconciliation like every other answer: it names who holds the run
    // now, which is what sends that screen back to PLAY.
    expect(parsed(refused).startedBy?.deviceId).toBe(laptop.deviceId);
    expect(parsed(refused).guesses).toEqual([]);
  });

  it('records nothing for a run the caller does not own — not even a score row', async () => {
    const { handler, asLaptop } = await twoDevices();
    await handler(wordEvent({ turnstileToken: 'ok' }));
    await handler(asLaptop({ turnstileToken: 'ok' }));
    handler.advance(wordRunFloorMs(1));
    await handler(wordEvent({ guesses: ['mer'] }));
    expect(
      await handler.scoreStore.list({ date: ACTIVE_DATE, lang: 'fr', mode: 'word' }),
    ).toEqual([]);
  });

  it('but the device that DID start it still submits normally', async () => {
    const { handler, asLaptop } = await twoDevices();
    await handler(wordEvent({ turnstileToken: 'ok' }));
    await handler(asLaptop({ turnstileToken: 'ok' }));
    handler.advance(wordRunFloorMs(1));
    const recorded = await handler(asLaptop({ guesses: ['mer'] }));
    expect(recorded.statusCode).toBe(200);
    expect(parsed(recorded).guesses).toEqual(['mer']);
  });

  it('and once a run is SUBMITTED, the other device cannot restart the day', async () => {
    const { handler, asLaptop } = await twoDevices();
    await handler(wordEvent({ turnstileToken: 'ok' }));
    handler.advance(wordRunFloorMs(2));
    const recorded = await handler(wordEvent({ guesses: ['mer', 'ocean'] }));
    expect(recorded.statusCode).toBe(200);

    const laptopStart = await handler(asLaptop({ turnstileToken: 'ok' }));
    // If a submission won the race, the restart fails and the caller adopts the final run.
    expect(laptopStart.statusCode).toBe(200);
    expect(parsed(laptopStart).guesses).toEqual(['mer', 'ocean']);
    expect(parsed(laptopStart).submittedAt).toBeTruthy();
  });

  it('a device on ANOTHER account is not a second device at all', async () => {
    const handler = makeHandler({ word: WORD_ARTIFACT });
    await handler(wordEvent({ turnstileToken: 'ok' }));
    const stranger = await seedDevice(handler.devices);
    const theirs = await handler(
      event({ query: WORD_QUERY, body: { token: stranger.token, puzzle: WORD_TAG } }),
    );
    // Rounds are keyed by ACCOUNT: nothing this device does can touch that run.
    expect(theirs.statusCode).toBe(404);
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

// CONTRACT (#202): the two stores answer alike, and a 0-claim run is a REAL submission.
// The memory store is what `backend:dev` and every route test above run on, so a rule it
// enforces differently from DynamoDB is a rule nothing here can see.
describe('word mode: a run that claimed nothing (#202)', () => {
  async function startedRound() {
    const handler = makeHandler({ word: WORD_ARTIFACT });
    await handler(wordEvent({ turnstileToken: 'ok' }));
    handler.advance(wordRunFloorMs(0));
    return handler;
  }

  it('records, and cannot then be overwritten by a later log', async () => {
    const handler = await startedRound();
    const first = await handler(wordEvent({ guesses: [] }));
    expect(first.statusCode).toBe(200);

    // An empty stored log reads exactly like an unsubmitted one by LENGTH — which is why
    // the submission carries its own marker. Without it this second call wins.
    const second = await handler(wordEvent({ guesses: ['mer'] }));
    expect(second.statusCode).toBe(200);
    expect(parsed(second).guesses).toEqual([]);
  });

  it('is visible to a mount READ as recorded', async () => {
    const handler = await startedRound();
    await handler(wordEvent({ guesses: [] }));
    const read = await handler(wordEvent());
    // The client marks the round submitted off this, so a device that adopts a finished
    // day does not post its empty log back on every visit.
    expect(parsed(read).submittedAt).toBeTruthy();
  });

  it('cannot be restarted away once recorded — an empty log is still a stored run', async () => {
    const handler = await startedRound();
    await handler(wordEvent({ guesses: [] }));
    const again = await handler(wordEvent({ turnstileToken: 'ok' }));
    // The marker is the attribute, so a 0-claim run ends the daily exactly like any other
    // (#217): the start is refused and the recorded run is what comes back.
    expect(parsed(again).submittedAt).toBeTruthy();
    expect(parsed(again).guesses).toEqual([]);
  });
});

// CONTRACT (#203): the server DERIVES what it used to be told.
describe('the derived summary (#203)', () => {
  // `SENTENCE`'s two holes both start at rank 2; typing a secret solves its own hole.
  const solvedKey = { date: ACTIVE_DATE, lang: 'fr', mode: 'sentence' as const };

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
        query: { lang: 'fr', date, mode: 'sentence' },
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
    expect(await handler.scoreStore.list({ date, lang: 'fr', mode: 'sentence' })).toEqual([]);
  });

  it('an archive WORD run records no score either — one rule, both dailies', async () => {
    // A word run's on-time instant is its server-stamped START (the submission is
    // deferred by design), and an archive replay's start is just as late as its submit.
    const handler = makeHandler({ word: WORD_ARTIFACT });
    const key = { lang: 'fr', date: PAST_DATE, mode: 'word' as const };
    await handler(wordEvent({ turnstileToken: 'ok' }, key));
    handler.advance(wordRunFloorMs(1) + 1);
    const submitted = await handler(wordEvent({ guesses: ['mer'] }, key));
    // The run was RECORDED — the log is the player's history, and an archive run is still
    // play. What it does not earn is the day's leaderboard entry.
    expect(submitted.statusCode).toBe(200);
    expect(parsed(submitted).submittedAt).toBeTruthy();
    expect(await handler.scoreStore.list(key)).toEqual([]);
  });

  it('a word run STARTED on its day keeps its row when the submit lands after the flip', async () => {
    // #202's own shape: the wait check FORCES a run started near 22:00 to submit after
    // the flip, and the log may arrive hours later on the revisit that finds the run
    // over. The row is judged at the server-stamped START — when the run was played —
    // never at the write's arrival, or normal deferred submission would silently cost a
    // legitimate run its leaderboard entry.
    const handler = makeHandler({ word: WORD_ARTIFACT });
    await handler(wordEvent({ turnstileToken: 'ok' }));
    // The tab dies mid-run; the revisit lands well past the 22:00 flip.
    handler.advance(13 * 3_600_000);
    const submitted = await handler(wordEvent({ guesses: ['mer'] }));
    expect(submitted.statusCode).toBe(200);
    expect(parsed(submitted).submittedAt).toBeTruthy();
    const rows = await handler.scoreStore.list({ lang: 'fr', date: ACTIVE_DATE, mode: 'word' });
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(1);
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

// CONTRACT (#203): ROUND START is Turnstile-gated in both modes. Round creation is
// available to every unlinked visitor, so it carries the challenge the retired score POST
// used to — and only round CREATION does: a later append to a record that already exists
// costs nothing.
describe('the round-start challenge (#203)', () => {
  it('refuses to CREATE a sentence round without a challenge', async () => {
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

  it('refuses a bare token on a sentence round — it names no write', async () => {
    const handler = makeHandler();
    const response = await handler(
      event({ body: { token: TOKEN, puzzle: PUZZLE, turnstileToken: 'tok' } }),
    );
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe('bad_request');
  });
});

// CONTRACT (#203): Word mode's end-of-run SUBMISSION is what records its score row, the
// way the solving append does for a sentence round. The claim count comes from the same
// log and the same artifact the write already validated against.
describe('the word run\'s recorded score (#203)', () => {
  const wordKey = { date: ACTIVE_DATE, lang: 'fr', mode: 'word' as const };

  async function startedRun() {
    const handler = makeHandler({ word: WORD_ARTIFACT });
    await handler(wordEvent({ turnstileToken: 'ok' }));
    return handler;
  }

  it('records the claim count when the run is stored', async () => {
    const handler = await startedRun();
    handler.advance(wordRunFloorMs(2) + 1);
    const submitted = await handler(wordEvent({ guesses: ['mer', 'ocean', 'zzz'] }));
    expect(submitted.statusCode).toBe(200);

    const rows = await handler.scoreStore.list(wordKey);
    // Two claims and a miss: the score is the CLAIMS, and it is the server's own count.
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(2);
  });

  it('records a 0-claim run — an empty log is a real result, not an absence', async () => {
    const handler = await startedRun();
    handler.advance(wordRunFloorMs(0) + 1);
    await handler(wordEvent({ guesses: [] }));
    expect(await handler.scoreStore.list(wordKey)).toEqual([
      { publicId: ME.accountId, score: 0 },
    ]);
  });

  it('records nothing on a REFUSED submission, and nothing more on a repeat', async () => {
    const handler = await startedRun();
    // Too early: the run cannot be over yet, so no row is written.
    const early = await handler(wordEvent({ guesses: ['mer'] }));
    expect(early.statusCode).toBe(409);
    expect(await handler.scoreStore.list(wordKey)).toEqual([]);

    handler.advance(wordRunFloorMs(1) + 1);
    await handler(wordEvent({ guesses: ['mer'] }));
    // First write wins: a second submission changes neither the log nor the population.
    await handler(wordEvent({ guesses: ['mer', 'ocean'] }));
    const rows = await handler.scoreStore.list(wordKey);
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(1);
  });
});


// CONTRACT (#203, added on review): an outcome this route CLAIMS has to be one the store
// actually holds, and an eventually-consistent read is never evidence of absence.
describe('what the answer is allowed to claim (#203)', () => {
  const solvedKey = { date: ACTIVE_DATE, lang: 'fr', mode: 'sentence' as const };

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
    expect(await handler.scoreStore.list({ date: ACTIVE_DATE, lang: 'fr', mode: 'sentence' })).toEqual(
      [],
    );
  });
});
