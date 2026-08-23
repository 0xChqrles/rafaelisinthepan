// CONTRACT (#201, reworked by #214): the round sync engine. The server owns each round's
// ordered guess log, and local storage is an OUTBOX holding only what it has not
// acknowledged:
//   - the mount READ is what the board is replayed from, so the engine PUBLISHES where a
//     round's state is — loading / ready with the server's own state / failed, and a failure
//     is a state the screen shows rather than permission to start from a guessed mirror;
//   - counted guesses are COALESCED behind the ~1s pacing, measured from the previous
//     write's ANSWER (the server times its own receipt instants), and each batch is the
//     oldest prefix of the outbox that still fits under the cap — sized against the RAW
//     stored log, never the play log's shorter merged length;
//   - EVERY answer — a 200 and BOTH refusals — carries the full stored state and REPLACES
//     the snapshot; a 2xx additionally settles the outbox by canonical identity (#104), so
//     the sent prefix and anything else the server now holds both leave it;
//   - a 429 keeps the outbox and paces; a 409 BELOW the cap keeps it and re-sizes; a 409
//     with an unsolved log AT the cap ends the round (nothing that never fit is kept), and
//     the capped state itself is DERIVED from that stored state, never a stored flag;
//   - a SOLVED round is frozen: its answer is adopted and the conversation closes, and what
//     was still pending is dropped for good;
//   - a write whose outcome is UNKNOWN re-reads before writing again, so an append is never
//     stored twice; a 4xx VERDICT closes the conversation instead of spinning.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RankMap, RuntimeHole } from '@whippin/shared';
import { postRoundBody } from '../api';
import { useGameStore, roundKeyForDay } from './gameStore';
import {
  backoffDelayMs,
  beginRoundSync,
  notifyGuess,
  resetRoundSync,
  retryRoundSync,
  writeDelayMs,
} from './roundSync';
import { replayHoles } from '../game/scoring';
import { ROUND_GUESS_CAP, ROUND_WRITE_MIN_MS } from '@whippin/shared';

// `roundUrl` is mocked with the rest (the house pattern — see useScoreHistogram.test.ts's
// `scoresUrl`, FriendInvite.test.ts's `friendsUrl`): the real builder throws without
// VITE_API_BASE_URL, which is a gitignored `.env.local` locally and absent in CI, so
// leaving it real makes this suite pass on a developer's machine and fail on the required
// check. What it builds is `api.test.ts`'s contract, not this one's. `parseRound` stays
// REAL — the engine's handling of a malformed body is part of what is under test here.
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postRoundBody: vi.fn(),
  roundUrl: (lang: string, date: string, mode: string) =>
    `https://api.test/round?lang=${lang}&date=${date}&mode=${mode}`,
}));

// ROUND CREATION is Turnstile-gated (#203): the engine mints a challenge for the append
// that creates the record. The real module throws without VITE_TURNSTILE_SITE_KEY (the
// `roundUrl` reason above) and would turn every creating append into a failed write.
vi.mock('../turnstile', () => ({ turnstileToken: async () => 'challenge' }));

const post = vi.mocked(postRoundBody);

const T0 = 1_700_000_000_000;
const KEY = roundKeyForDay(21, 'fr');
const SECRET_MAP: RankMap = {
  foret: {
    foret: { word: 'forêt', rank: 0 },
    foretz: { word: 'forêt', rank: 0 },
    bois: { word: 'bois', rank: 5 },
    chemin: { word: 'chemin', rank: 87 },
  },
  ancienne: {
    ancienne: { word: 'ancienne', rank: 0 },
    vieille: { word: 'vieille', rank: 40 },
  },
};

function freshHoles(): RuntimeHole[] {
  return [
    { pos: 1, secret: 'foret', word: 'bois', rank: 87, startRank: 87 },
    { pos: 2, secret: 'ancienne', word: 'vieille', rank: 40, startRank: 40 },
  ];
}

// The published VERSION a round is played on (#203) — the round's identity everywhere, and
// what a republish changes.
const REVISION = 'a1b2c3d4e5f60718';
const CORRECTED_REVISION = 'b2c3d4e5f6071829';

function ctx(key: string = KEY, revision: string = REVISION) {
  return {
    roundKey: key,
    lang: 'fr',
    mode: 'sentence',
    date: '2026-08-21',
    revision,
    ranks: SECRET_MAP,
  } as const;
}

function ok(guesses: string[], solved = false) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      guesses,
      createdAt: '2026-08-21T09:00:00.000Z',
      // Every answer carries the server's own clock (#202); a sentence round has no
      // startedAt to carry with it. `solved` is what the SERVER derived from the log it
      // stores (#203) — the fact that says the day's score row exists.
      solved,
      now: '2026-08-21T09:30:00.000Z',
    }),
  } as unknown as Response;
}

// A refusal is an ANSWER: 409 and 429 carry the stored state of the puzzle ASKED about,
// exactly like a 200. An EMPTY one (no record of this puzzle yet — a rate-refused restart)
// carries an empty `createdAt`, which is what tells "refused an existing round" from
// "refused before creating one".
function refusal(status: number, guesses: string[], error?: string, solved = false) {
  return {
    ok: false,
    status,
    json: async () => ({
      error: error ?? (status === 409 ? 'round_full' : 'too_fast'),
      message: 'refused',
      guesses,
      solved,
      createdAt: guesses.length === 0 ? '' : '2026-08-21T09:00:00.000Z',
      now: '2026-08-21T09:30:00.000Z',
    }),
  } as unknown as Response;
}

function status(code: number) {
  return { ok: false, status: code, json: async () => ({}) } as unknown as Response;
}

// Seed the OUTBOX — the only persisted sentence state since #214.
function seedOutbox(guesses: string[] = [], key: string = KEY, puzzle: string = REVISION) {
  useGameStore.setState(
    (s) => ({ outbox: { ...s.outbox, [key]: { puzzle, guesses } } }),
    false,
  );
}

function outbox(key: string = KEY): string[] {
  return useGameStore.getState().outbox[key]?.guesses ?? [];
}

function load(key: string = KEY) {
  return useGameStore.getState().roundLoads[key];
}

// The server state the engine published, or undefined while it has not settled.
function server(key: string = KEY) {
  const entry = load(key);
  return entry?.status === 'ready' ? entry.server : undefined;
}

// The two facts the SCREEN derives from that state (#214). Restated here rather than
// imported, because what is pinned is the SHAPE the screen reads, not Game's spelling of it.
function capped(key: string = KEY): boolean {
  const s = server(key);
  return s !== undefined && !s.solved && s.guesses.length >= ROUND_GUESS_CAP;
}

function bodyOf(call: number): {
  secret: string;
  puzzle: string;
  guesses?: string[];
  turnstileToken?: string;
} {
  return post.mock.calls[call][1] as {
    secret: string;
    puzzle: string;
    guesses?: string[];
    turnstileToken?: string;
  };
}

async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

// One local try more than the server will ever hold. Distinct strings, so `guessKey`
// (which falls back to the typed form for a guess no map ranks) keeps them apart.
function overCapLog(): string[] {
  return Array.from({ length: ROUND_GUESS_CAP + 1 }, (_, i) => `try-${i.toString(36)}`);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetRoundSync();
  post.mockReset();
  useGameStore.setState(
    { outbox: {}, wordRounds: {}, roundLoads: {}, activeWordKey: null },
    false,
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('replayHoles', () => {
  it('walks the log under the game-loop rule: closer word + lower rank, solved locked', () => {
    const holes = replayHoles(freshHoles(), SECRET_MAP, ['bois', 'ancienne']);
    expect(holes[0]).toMatchObject({ word: 'bois', rank: 5 }); // improved
    expect(holes[1]).toMatchObject({ word: 'ancienne', rank: 0 }); // solved
    // The fresh template is never mutated.
    expect(freshHoles()[0]).toMatchObject({ word: 'bois', rank: 87 });
  });
});

describe('write pacing', () => {
  it('flushes the first write immediately', () => {
    expect(writeDelayMs(0, T0)).toBe(0);
  });

  it('measures the interval from the previous write\'s ANSWER, not its send', () => {
    // The server compares its OWN receipt instants with a strict `<`, so pacing from the
    // send instant leaves zero margin: any request faster than its predecessor is a 429.
    // Waiting from the answer puts the server's round trip inside the gap.
    expect(writeDelayMs(T0, T0 + 500)).toBe(ROUND_WRITE_MIN_MS - 500);
    expect(writeDelayMs(T0, T0 + ROUND_WRITE_MIN_MS)).toBe(0);
  });

  it('doubles the retry window per consecutive failure up to a 30s ceiling', () => {
    expect(backoffDelayMs(0, T0, T0)).toBe(0);
    expect(backoffDelayMs(1, T0, T0)).toBe(2 * ROUND_WRITE_MIN_MS);
    expect(backoffDelayMs(5, T0, T0)).toBe(30_000);
    expect(backoffDelayMs(20, T0, T0)).toBe(30_000);
  });
});

describe('the mount read — what the screen waits on', () => {
  it('publishes LOADING the moment the round registers', () => {
    post.mockReturnValue(new Promise(() => {})); // never settles
    seedOutbox();
    beginRoundSync(ctx());
    expect(load()).toEqual({ status: 'loading', puzzle: REVISION });
  });

  it('publishes the server\'s state on a 200', async () => {
    post.mockResolvedValueOnce(ok(['bois', 'chemin']));
    seedOutbox();
    beginRoundSync(ctx());
    await settle();
    expect(load()).toEqual({
      status: 'ready',
      puzzle: REVISION,
      server: { guesses: ['bois', 'chemin'], solved: false, solvedByAppend: false, credited: false },
    });
    // A READ never writes: the request carries no guesses.
    expect(bodyOf(0).guesses).toBeUndefined();
  });

  it('publishes an EMPTY ready state on a 404 — "nothing yet" is an answer', async () => {
    post.mockResolvedValueOnce(status(404));
    seedOutbox();
    beginRoundSync(ctx());
    await settle();
    expect(load()).toEqual({
      status: 'ready',
      puzzle: REVISION,
      server: { guesses: [], solved: false, solvedByAppend: false, credited: false },
    });
  });

  it('publishes FAILED on a transport error, and RECOVERS on the retry', async () => {
    post.mockRejectedValueOnce(new Error('offline'));
    seedOutbox();
    beginRoundSync(ctx());
    await settle();
    expect(load()).toEqual({ status: 'failed', puzzle: REVISION });

    post.mockResolvedValueOnce(ok(['bois']));
    await settle(2 * ROUND_WRITE_MIN_MS);
    expect(server()?.guesses).toEqual(['bois']);
  });

  it('publishes FAILED and CLOSES on a verdict', async () => {
    post.mockResolvedValueOnce(status(400));
    seedOutbox(['bois']);
    beginRoundSync(ctx());
    await settle(60_000);
    expect(load()).toEqual({ status: 'failed', puzzle: REVISION });
    expect(post).toHaveBeenCalledTimes(1); // no spinning
  });

  it('RETRY re-opens a conversation a verdict closed', async () => {
    post.mockResolvedValueOnce(status(400));
    seedOutbox();
    beginRoundSync(ctx());
    await settle();
    expect(load()).toEqual({ status: 'failed', puzzle: REVISION });

    post.mockResolvedValueOnce(ok(['bois']));
    retryRoundSync(KEY);
    await settle();
    expect(server()?.guesses).toEqual(['bois']);
  });

  it('drops outbox entries the server\'s log already represents, by IDENTITY', async () => {
    // 'foretz' resolves identically to 'foret' in every map, so the server holding one
    // acknowledges the other: re-sending it would append a duplicate the play log hides.
    post.mockResolvedValueOnce(ok(['foret']));
    seedOutbox(['foretz', 'bois']);
    beginRoundSync(ctx());
    await settle();
    expect(outbox()).toEqual(['bois']);
  });

  it('keeps the WHOLE outbox on a 404 — the server acknowledged nothing', async () => {
    post.mockResolvedValueOnce(status(404));
    seedOutbox(['bois', 'chemin']);
    beginRoundSync(ctx());
    await settle();
    expect(outbox()).toEqual(['bois', 'chemin']);
  });

  it('a FAILED re-read never pulls an interactive round back to an error state', async () => {
    post.mockResolvedValueOnce(ok([]));
    seedOutbox();
    beginRoundSync(ctx());
    await settle();
    expect(load()?.status).toBe('ready');

    // The round is being played now; an append whose outcome is unknown re-reads, and that
    // read failing is a sync hiccup behind a live board, not a load failure.
    seedOutbox(['bois']);
    post.mockRejectedValueOnce(new Error('offline')); // the append
    post.mockRejectedValueOnce(new Error('offline')); // its recovery read
    notifyGuess(KEY);
    await settle(10 * ROUND_WRITE_MIN_MS);
    expect(load()?.status).toBe('ready');
  });
});

describe('appends — coalescing, pacing and the batch prefix', () => {
  async function ready(serverLog: string[] = []) {
    post.mockResolvedValueOnce(serverLog.length ? ok(serverLog) : status(404));
    seedOutbox();
    beginRoundSync(ctx());
    await settle();
    post.mockReset();
  }

  it('flushes the outbox as ONE batch and settles it against the answer', async () => {
    await ready();
    seedOutbox(['bois', 'chemin']);
    post.mockResolvedValueOnce(ok(['bois', 'chemin']));
    notifyGuess(KEY);
    await settle();
    expect(bodyOf(0).guesses).toEqual(['bois', 'chemin']);
    expect(outbox()).toEqual([]);
    expect(server()?.guesses).toEqual(['bois', 'chemin']);
  });

  it('KEEPS guesses appended while the write was in flight', async () => {
    await ready();
    seedOutbox(['bois']);
    let release: (r: Response) => void = () => {};
    post.mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve; }));
    notifyGuess(KEY);
    await settle();
    // The player keeps typing while the request is out.
    useGameStore.getState().appendOutbox(KEY, REVISION, 'chemin');
    release(ok(['bois']));
    await settle();
    expect(outbox()).toEqual(['chemin']);
  });

  it('paces the next append from the previous ANSWER', async () => {
    await ready();
    seedOutbox(['bois']);
    post.mockResolvedValueOnce(ok(['bois']));
    notifyGuess(KEY);
    await settle();
    expect(post).toHaveBeenCalledTimes(1);

    seedOutbox(['chemin']);
    post.mockResolvedValueOnce(ok(['bois', 'chemin']));
    notifyGuess(KEY);
    await settle(ROUND_WRITE_MIN_MS - 1);
    expect(post).toHaveBeenCalledTimes(1); // still inside the interval
    await settle(1);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('sends the OLDEST PREFIX that fits, sized against the RAW stored log', async () => {
    // The play log would be shorter here (the merge dedups), but the cap counts what is
    // STORED — so the room is measured on the raw log the answer carried.
    const stored = Array.from({ length: ROUND_GUESS_CAP - 2 }, (_, i) => `s-${i.toString(36)}`);
    await ready(stored);
    seedOutbox(['a-one', 'b-two', 'c-three', 'd-four']);
    post.mockResolvedValueOnce(ok([...stored, 'a-one', 'b-two']));
    notifyGuess(KEY);
    await settle();
    expect(bodyOf(0).guesses).toEqual(['a-one', 'b-two']);
    expect(outbox()).toEqual(['c-three', 'd-four']);
  });

  it('never sends a batch the route can only refuse', async () => {
    await ready();
    seedOutbox(overCapLog());
    post.mockResolvedValueOnce(ok(overCapLog().slice(0, ROUND_GUESS_CAP)));
    notifyGuess(KEY);
    await settle();
    expect(bodyOf(0).guesses).toHaveLength(ROUND_GUESS_CAP);
  });
});

describe('the round-start challenge (#203)', () => {
  it('carries a challenge on the append that CREATES the record, and none after', async () => {
    post.mockResolvedValueOnce(status(404)); // nothing stored yet
    seedOutbox();
    beginRoundSync(ctx());
    await settle();

    seedOutbox(['bois']);
    post.mockResolvedValueOnce(ok(['bois']));
    notifyGuess(KEY);
    await settle();
    expect(bodyOf(1).turnstileToken).toBe('challenge');

    seedOutbox(['chemin']);
    post.mockResolvedValueOnce(ok(['bois', 'chemin']));
    notifyGuess(KEY);
    await settle(ROUND_WRITE_MIN_MS);
    expect(bodyOf(2).turnstileToken).toBeUndefined();
  });

  it('carries none when the READ already found a record', async () => {
    post.mockResolvedValueOnce(ok(['bois']));
    seedOutbox(['chemin']);
    beginRoundSync(ctx());
    await settle();
    post.mockResolvedValueOnce(ok(['bois', 'chemin']));
    await settle(ROUND_WRITE_MIN_MS);
    expect(bodyOf(1).turnstileToken).toBeUndefined();
  });

  it('a rate-refused RESTART is NOT creation — the retry still carries a challenge', async () => {
    // `stateForTag`: a refusal about a puzzle the server holds no record of answers the
    // EMPTY state. Taking that as creation makes the retry omit the challenge, which is a
    // 403, which is a verdict — closing a round that was never created.
    post.mockResolvedValueOnce(status(404));
    seedOutbox();
    beginRoundSync(ctx());
    await settle();

    seedOutbox(['bois']);
    post.mockResolvedValueOnce(refusal(429, [])); // empty state -> createdAt ''
    notifyGuess(KEY);
    await settle();
    expect(bodyOf(1).turnstileToken).toBe('challenge');

    post.mockResolvedValueOnce(ok(['bois']));
    await settle(2 * ROUND_WRITE_MIN_MS);
    expect(bodyOf(2).turnstileToken).toBe('challenge');
  });
});

describe('the four refusals', () => {
  async function ready(serverLog: string[] = []) {
    post.mockResolvedValueOnce(serverLog.length ? ok(serverLog) : status(404));
    seedOutbox();
    beginRoundSync(ctx());
    await settle();
    post.mockReset();
  }

  it('429 too_fast: adopts the snapshot, KEEPS the outbox, paces from this answer', async () => {
    await ready(['bois']);
    seedOutbox(['chemin']);
    post.mockResolvedValueOnce(refusal(429, ['bois', 'vieille']));
    notifyGuess(KEY);
    await settle();
    expect(server()?.guesses).toEqual(['bois', 'vieille']);
    expect(outbox()).toEqual(['chemin']);

    post.mockResolvedValueOnce(ok(['bois', 'vieille', 'chemin']));
    await settle(ROUND_WRITE_MIN_MS);
    expect(bodyOf(1).guesses).toEqual(['chemin']);
  });

  it('409 round_full BELOW the cap: the batch overshot, the ROUND has room', async () => {
    // Another device pushed the stored log forward while this tab was away, so a batch
    // clamped correctly when it was built no longer fits. Concluding "capped" from the
    // status alone would end a round that was never full.
    const stored = Array.from({ length: ROUND_GUESS_CAP - 1 }, (_, i) => `s-${i.toString(36)}`);
    await ready(stored.slice(0, ROUND_GUESS_CAP - 3));
    seedOutbox(['a-one', 'b-two', 'c-three']);
    post.mockResolvedValueOnce(refusal(409, stored));
    notifyGuess(KEY);
    await settle();
    expect(capped()).toBe(false);
    expect(outbox()).toEqual(['a-one', 'b-two', 'c-three']);

    // And the next attempt is sized from the truth the refusal carried: one slot left.
    post.mockResolvedValueOnce(ok([...stored, 'a-one']));
    await settle(ROUND_WRITE_MIN_MS);
    expect(bodyOf(1).guesses).toEqual(['a-one']);
  });

  it('409 round_full AT the cap, unsolved: the round is capped and closes', async () => {
    const full = Array.from({ length: ROUND_GUESS_CAP }, (_, i) => `s-${i.toString(36)}`);
    await ready(full.slice(0, ROUND_GUESS_CAP - 1));
    seedOutbox(['a-one', 'b-two']);
    post.mockResolvedValueOnce(refusal(409, full));
    notifyGuess(KEY);
    await settle(60_000);
    expect(capped()).toBe(true);
    // Anything that never fit is discarded — it can never be stored.
    expect(outbox()).toEqual([]);
    expect(post).toHaveBeenCalledTimes(1); // the conversation is over
  });

  it('a solve accepted AS raw entry 500 is an ordinary solved round, not capped', async () => {
    const full = Array.from({ length: ROUND_GUESS_CAP }, (_, i) => `s-${i.toString(36)}`);
    post.mockResolvedValueOnce(ok(full, true));
    seedOutbox();
    beginRoundSync(ctx());
    await settle();
    expect(server()?.solved).toBe(true);
    expect(capped()).toBe(false);
  });

  it('409 round_solved: adopts the frozen state, DISCARDS the outbox, closes', async () => {
    await ready(['bois']);
    seedOutbox(['chemin']);
    post.mockResolvedValueOnce(refusal(409, ['bois', 'foret', 'ancienne'], 'round_solved', true));
    notifyGuess(KEY);
    await settle(60_000);
    expect(server()).toEqual({
      guesses: ['bois', 'foret', 'ancienne'],
      solved: true,
      // Learned from a refusal, not confirmed on this device's batch: adopted history.
      solvedByAppend: false,
      credited: false,
    });
    // The guesses it refused are never stored, so keeping them would leave the screen
    // counting tries the recorded score does not.
    expect(outbox()).toEqual([]);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('a plain 4xx VERDICT closes without spinning', async () => {
    await ready(['bois']);
    seedOutbox(['chemin']);
    post.mockResolvedValueOnce(status(400));
    notifyGuess(KEY);
    await settle(120_000);
    expect(post).toHaveBeenCalledTimes(1);
    // The outbox stands: the next visit asks once more.
    expect(outbox()).toEqual(['chemin']);
  });
});

describe('unknown write outcomes re-READ before writing again', () => {
  async function ready() {
    post.mockResolvedValueOnce(status(404));
    seedOutbox();
    beginRoundSync(ctx());
    await settle();
    post.mockReset();
  }

  it('a transport error is followed by a read, and only the REMAINDER is retried', async () => {
    // The write may have committed. Re-sending it would `list_append` the same guesses a
    // second time — burning cap slots on duplicates the play log then hides.
    await ready();
    seedOutbox(['bois', 'chemin']);
    post.mockRejectedValueOnce(new Error('gateway timeout'));
    notifyGuess(KEY);
    await settle();

    post.mockResolvedValueOnce(ok(['bois'])); // it HAD committed, partially
    await settle(2 * ROUND_WRITE_MIN_MS);
    expect(bodyOf(1).guesses).toBeUndefined(); // a READ
    expect(outbox()).toEqual(['chemin']);

    post.mockResolvedValueOnce(ok(['bois', 'chemin']));
    await settle(2 * ROUND_WRITE_MIN_MS);
    expect(bodyOf(2).guesses).toEqual(['chemin']);
  });

  it('a 5xx takes the same path', async () => {
    await ready();
    seedOutbox(['bois']);
    post.mockResolvedValueOnce(status(500));
    notifyGuess(KEY);
    await settle();
    post.mockResolvedValueOnce(ok(['bois']));
    await settle(2 * ROUND_WRITE_MIN_MS);
    expect(bodyOf(1).guesses).toBeUndefined();
    expect(outbox()).toEqual([]);
  });

  it('an unparseable body takes the same path', async () => {
    await ready();
    seedOutbox(['bois']);
    post.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ nonsense: true }),
    } as unknown as Response);
    notifyGuess(KEY);
    await settle();
    post.mockResolvedValueOnce(ok([]));
    await settle(2 * ROUND_WRITE_MIN_MS);
    expect(bodyOf(1).guesses).toBeUndefined();
  });
});

describe('the SERVER\'s solve (#203/#214)', () => {
  it('a 200 append that turns the round solved is a FRESH solve', async () => {
    post.mockResolvedValueOnce(status(404));
    seedOutbox();
    beginRoundSync(ctx());
    await settle();

    seedOutbox(['foret']);
    post.mockResolvedValueOnce(ok(['foret'], true));
    notifyGuess(KEY);
    await settle();
    expect(server()).toEqual({ guesses: ['foret'], solved: true, solvedByAppend: true, credited: false });
  });

  it('a solve read at MOUNT is adopted history — nothing may celebrate it', async () => {
    post.mockResolvedValueOnce(ok(['foret', 'ancienne'], true));
    seedOutbox();
    beginRoundSync(ctx());
    await settle();
    expect(server()?.solved).toBe(true);
    expect(server()?.solvedByAppend).toBe(false);
  });

  it('a solved round read at mount FREEZES: nothing is appended, the outbox is dropped', async () => {
    post.mockResolvedValueOnce(ok(['foret', 'ancienne'], true));
    seedOutbox(['chemin']);
    beginRoundSync(ctx());
    await settle(60_000);
    expect(outbox()).toEqual([]);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('a later answer never downgrades a fresh solve to adopted history', async () => {
    post.mockResolvedValueOnce(status(404));
    seedOutbox();
    beginRoundSync(ctx());
    await settle();
    seedOutbox(['foret']);
    post.mockResolvedValueOnce(ok(['foret'], true));
    notifyGuess(KEY);
    await settle();
    // A remount re-registers the same conversation; it is closed, so nothing re-reads —
    // but the fact this device earned must survive any re-registration.
    beginRoundSync(ctx());
    await settle();
    expect(server()?.solvedByAppend).toBe(true);
  });
});

describe('a republish under an open conversation', () => {
  it('starts the conversation over and re-reads', async () => {
    post.mockResolvedValueOnce(ok(['bois']));
    seedOutbox();
    beginRoundSync(ctx());
    await settle();
    expect(server()?.guesses).toEqual(['bois']);

    post.mockResolvedValueOnce(status(404));
    seedOutbox([], KEY, CORRECTED_REVISION);
    beginRoundSync(ctx(KEY, CORRECTED_REVISION));
    expect(load()).toEqual({ status: 'loading', puzzle: CORRECTED_REVISION });
    await settle();
    expect(bodyOf(1).puzzle).toBe(CORRECTED_REVISION);
    expect(server()?.guesses).toEqual([]);
  });

  it('re-OPENS a conversation the cap had closed — a fresh round is not a capped one', async () => {
    const full = Array.from({ length: ROUND_GUESS_CAP }, (_, i) => `s-${i.toString(36)}`);
    post.mockResolvedValueOnce(ok(full));
    seedOutbox();
    beginRoundSync(ctx());
    await settle();
    expect(capped()).toBe(true);

    post.mockResolvedValueOnce(status(404));
    seedOutbox([], KEY, CORRECTED_REVISION);
    beginRoundSync(ctx(KEY, CORRECTED_REVISION));
    await settle();
    expect(capped()).toBe(false);
  });

  it('an answer that lands AFTER the republish writes nothing', async () => {
    let release: (r: Response) => void = () => {};
    post.mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve; }));
    seedOutbox();
    beginRoundSync(ctx());
    await settle();

    // The correction registers while the read is still in the air.
    post.mockResolvedValueOnce(status(404));
    seedOutbox([], KEY, CORRECTED_REVISION);
    beginRoundSync(ctx(KEY, CORRECTED_REVISION));
    await settle();

    release(ok(['bois', 'chemin'])); // the RETIRED puzzle's log
    await settle();
    expect(server()?.guesses).toEqual([]);
  });

  it('never sends an outbox belonging to a retired revision', async () => {
    post.mockResolvedValueOnce(status(404));
    seedOutbox(['bois']); // still stamped with REVISION
    beginRoundSync(ctx(KEY, CORRECTED_REVISION)); // the round is playing the correction
    await settle(60_000);
    // The read went out; nothing else did, because the outbox names another puzzle.
    expect(post).toHaveBeenCalledTimes(1);
    expect(bodyOf(0).guesses).toBeUndefined();
  });
});

describe('flight eviction', () => {
  it('FORGETS an evicted round\'s state — its next mount reads again', async () => {
    const keys = [0, 1, 2, 3].map((i) => roundKeyForDay(30 + i, 'fr'));
    for (const key of keys) {
      post.mockResolvedValueOnce(ok(['bois']));
      seedOutbox([], key);
      beginRoundSync(ctx(key));
      await settle();
    }
    // MAX_FLIGHTS is 3: the least recently registered conversation is dropped, and its
    // published state goes with it rather than lingering as a stale "ready".
    expect(load(keys[0])).toBeUndefined();
    expect(load(keys[3])?.status).toBe('ready');
  });
});

describe('publishing an UNCHANGED state writes nothing', () => {
  it('keeps the same object when the server echoes back what we just sent', async () => {
    // The common answer. Handing the round a NEW state object about once a second while a
    // player types would recompute every derivation downstream — the play log, the board
    // replay, the run's trajectory — for a value that did not change.
    post.mockResolvedValueOnce(ok(['bois']));
    seedOutbox();
    beginRoundSync(ctx());
    await settle();
    const first = load();

    post.mockResolvedValueOnce(ok(['bois'])); // an append whose answer says the same thing
    seedOutbox(['bois']); // already held by the server, so this settles to nothing
    notifyGuess(KEY);
    await settle(2 * ROUND_WRITE_MIN_MS);
    expect(load()).toBe(first);
  });

  it('still publishes when the log actually moved', async () => {
    post.mockResolvedValueOnce(ok(['bois']));
    seedOutbox();
    beginRoundSync(ctx());
    await settle();
    const first = load();

    seedOutbox(['chemin']);
    post.mockResolvedValueOnce(ok(['bois', 'chemin']));
    notifyGuess(KEY);
    await settle(2 * ROUND_WRITE_MIN_MS);
    expect(load()).not.toBe(first);
    expect(server()?.guesses).toEqual(['bois', 'chemin']);
  });
});
