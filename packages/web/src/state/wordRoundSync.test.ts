// CONTRACT (#202): Word mode's conversation with the server. The mode writes exactly
// TWICE — a Turnstile-gated START that stamps the round's clock from the SERVER's own
// clock, and ONE end-of-run submission carrying the whole log — with a mount READ that
// writes nothing and makes the daily one-shot across devices.
//
//   - the visible clock is anchored to `now - startedAt`, an ELAPSED SPAN, so a skewed
//     device clock cannot shorten or lengthen a run — and the request's own travel time
//     lands INSIDE the run, which is the margin that keeps an honest submission clear of
//     the server's wait check;
//   - the START is idempotent from the client's side too: one challenge, one write, however
//     many times PLAY is tapped;
//   - a run that ended is submitted ONCE, truncated to what the route accepts, and the
//     acknowledgement is persisted so a revisit does not re-post it;
//   - `too_early` is waited out (it is an answer about WHEN); every other 4xx is a VERDICT
//     that closes the conversation instead of spinning on it.
//
// Asserted against the spec, not the implementation.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WordRanks } from '@whippin/shared';
import { WORD_MISS_CAP } from '@whippin/shared';
import { postRoundBody } from '../api';
import { turnstileToken } from '../turnstile';
import { useGameStore, roundKeyForDay } from './gameStore';
import { runMs } from '../game/wordGame';
import {
  anchorFrom,
  beginWordRoundSync,
  resetWordRoundSync,
  startWordRound,
  startedRunHere,
  submittableLog,
  wordTag,
} from './wordRoundSync';

// `roundUrl` is mocked with the rest (the house pattern): the real builder throws without
// VITE_API_BASE_URL, which is a gitignored `.env.local` locally and absent in CI. What it
// builds is `api.test.ts`'s contract, not this one's. `parseRound` stays REAL — the
// engine's handling of a malformed body is part of what is under test here.
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postRoundBody: vi.fn(),
  roundUrl: (lang: string, date: string, mode: string) =>
    `https://api.test/round?lang=${lang}&date=${date}&mode=${mode}`,
}));

// The invisible challenge is the one thing this engine cannot exercise for real.
vi.mock('../turnstile', () => ({ turnstileToken: vi.fn() }));

const post = vi.mocked(postRoundBody);
const challenge = vi.mocked(turnstileToken);

const T0 = 1_700_000_000_000;
const KEY = roundKeyForDay(21, 'fr', 'word');
const WORD = 'phare';
const RANKS: WordRanks = {
  phare: { word: 'phare', rank: 0, freq: 5_000 },
  mer: { word: 'mer', rank: 1, dq: 255, freq: 100 },
  ocean: { word: 'océan', rank: 2, dq: 200, freq: 800 },
  loin: { word: 'loin', rank: 5_000, dq: 0, freq: 300 },
};

function ctx() {
  return { roundKey: KEY, lang: 'fr', date: '2026-08-21', word: WORD, ranks: RANKS, corpusSize: 1_000 };
}

// An instant on the SERVER's clock, `ms` after the fixed reference the answers are built
// around. The client's own clock is deliberately a different number.
const SERVER_T0 = Date.parse('2026-08-21T14:00:00.000Z');
const at = (ms: number) => new Date(SERVER_T0 + ms).toISOString();

function answer(
  status: number,
  body: { guesses?: string[]; startedAt?: string; nowAt?: number; error?: string },
) {
  const { nowAt = 0, ...rest } = body;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({
      guesses: rest.guesses ?? [],
      createdAt: at(0),
      ...(rest.startedAt ? { startedAt: rest.startedAt } : {}),
      now: at(nowAt),
      ...(rest.error ? { error: rest.error, message: 'refused' } : {}),
    }),
  } as unknown as Response;
}

function seedRound(extra: Record<string, unknown> = {}) {
  useGameStore.setState(
    (s) => ({
      wordRounds: {
        ...s.wordRounds,
        [KEY]: { word: WORD, startedAt: null, deadline: null, tried: [], claimed: 0, ...extra },
      },
      activeWordKey: KEY,
    }),
    false,
  );
}

const round = () => useGameStore.getState().wordRounds[KEY];

function bodyOf(call: number) {
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetWordRoundSync();
  post.mockReset();
  challenge.mockReset();
  challenge.mockResolvedValue('token');
  useGameStore.setState({ rounds: {}, wordRounds: {}, activeKey: null, activeWordKey: null }, false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('wordTag', () => {
  it('is the short opaque tag the route accepts, and names the WORD', () => {
    expect(wordTag(WORD)).toMatch(/^[a-z0-9]{1,32}$/);
    expect(wordTag('autre')).not.toBe(wordTag(WORD));
  });
});

describe('anchorFrom — the run’s clock, translated', () => {
  it('holds the ELAPSED span, so a device clock hours off still runs one minute', () => {
    // The server says 20s have passed. Whatever this device thinks the date is, the run
    // has 40 of its 60 seconds left.
    const state = { guesses: [], createdAt: at(0), startedAt: at(0), now: at(20_000) };
    expect(anchorFrom(state, T0)).toBe(T0 - 20_000);
    // Skewing the device clock by an hour moves the anchor with it, never the span.
    expect(anchorFrom(state, T0 + 3_600_000)).toBe(T0 + 3_600_000 - 20_000);
  });

  it('is null when no run has been started', () => {
    expect(anchorFrom({ guesses: [], createdAt: at(0), startedAt: null, now: at(0) }, T0)).toBeNull();
  });
});

describe('submittableLog — what the route will store', () => {
  it(`keeps every claim and truncates the misses to ${WORD_MISS_CAP}`, () => {
    const misses = Array.from({ length: WORD_MISS_CAP + 5 }, (_, i) => `miss${i}`);
    const log = submittableLog(RANKS, ['mer', ...misses, 'ocean']);
    // Both claims survive; only the overflow misses are dropped, and the order holds.
    expect(log.filter((g) => g === 'mer' || g === 'ocean')).toEqual(['mer', 'ocean']);
    expect(log).toHaveLength(WORD_MISS_CAP + 2);
    expect(log[0]).toBe('mer');
    expect(log.at(-1)).toBe('ocean');
  });

  it('counts a NEAR miss as a miss — it claimed nothing', () => {
    expect(submittableLog(RANKS, ['loin'])).toEqual(['loin']);
  });
});

describe('the round START', () => {
  it('asks for a challenge and anchors the clock the SERVER stamped', async () => {
    seedRound();
    const started = startWordRound(ctx());
    post.mockResolvedValueOnce(answer(200, { startedAt: at(0), nowAt: 0 }));
    await expect(started).resolves.toBe(true);

    expect(bodyOf(0)).toMatchObject({ puzzle: wordTag(WORD), turnstileToken: 'token' });
    // Nothing is sent as a guess: the start writes a clock, not a log.
    expect(bodyOf(0).guesses).toBeUndefined();
    expect(round()).toMatchObject({ startedAt: T0, deadline: T0 + runMs(0) });
  });

  it('RESUMES a run already in progress — the daily is one-shot across devices', async () => {
    seedRound();
    post.mockResolvedValueOnce(answer(200, { startedAt: at(0), nowAt: 20_000 }));
    await startWordRound(ctx());
    // 20 seconds gone on the server's clock: this device joins with 40 left, not 60.
    expect(round()).toMatchObject({ startedAt: T0 - 20_000, deadline: T0 - 20_000 + runMs(0) });
  });

  it('is ONE challenge and ONE write however many times PLAY is tapped', async () => {
    seedRound();
    post.mockResolvedValue(answer(200, { startedAt: at(0) }));
    const both = await Promise.all([startWordRound(ctx()), startWordRound(ctx())]);
    expect(both).toEqual([true, true]);
    expect(challenge).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('reports failure without starting a clock — a refused start is a run that never began', async () => {
    seedRound();
    post.mockResolvedValueOnce(answer(403, { error: 'turnstile_rejected' }));
    await expect(startWordRound(ctx())).resolves.toBe(false);
    expect(round()).toMatchObject({ startedAt: null, deadline: null });

    // …and a later tap can still succeed: nothing is latched by the failure.
    post.mockResolvedValueOnce(answer(200, { startedAt: at(0) }));
    await expect(startWordRound(ctx())).resolves.toBe(true);
    expect(round().startedAt).toBe(T0);
  });

  it('reports failure when the challenge itself never lands', async () => {
    seedRound();
    challenge.mockRejectedValueOnce(new Error('blocked'));
    await expect(startWordRound(ctx())).resolves.toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
});

describe('the mount READ', () => {
  it('resumes a run this device never started', async () => {
    seedRound();
    post.mockResolvedValueOnce(answer(200, { startedAt: at(0), nowAt: 30_000 }));
    beginWordRoundSync(ctx(), false);
    await settle();
    expect(bodyOf(0).guesses).toBeUndefined();
    expect(round()).toMatchObject({ startedAt: T0 - 30_000 });
  });

  it('carries a finished day’s RECORDED run to a device that never played it', async () => {
    seedRound();
    post.mockResolvedValueOnce(
      answer(200, { startedAt: at(0), nowAt: 300_000, guesses: ['mer', 'loin'] }),
    );
    beginWordRoundSync(ctx(), false);
    await settle();
    expect(round()).toMatchObject({ tried: ['mer', 'loin'], claimed: 1 });
    // The deadline is re-priced off the adopted log and sits in the past: the run this
    // device is reading about is over.
    expect(round().deadline!).toBeLessThan(T0);
    // …and the server demonstrably holds it, so nothing is owed. Without this the device
    // would POST the adopted run straight back on this visit and on every later one.
    expect(round().submitted).toBe(true);

    beginWordRoundSync(ctx(), true);
    await settle(60_000);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('leaves an unplayed day alone on a 404 — PLAY is what creates the record', async () => {
    seedRound();
    post.mockResolvedValueOnce(answer(404, { error: 'not_found' }));
    beginWordRoundSync(ctx(), false);
    await settle();
    expect(round()).toMatchObject({ startedAt: null, tried: [] });
  });

  // A republished WORD restarts the round on both ends. Everything the flight knew describes
  // the retired one — including "its run ended and its log is unsent". Carrying that across
  // made the fresh round's first act a submission of the empty log the reset just gave it,
  // refused `not_started`, taken as a verdict, and the conversation closed for the session:
  // the word the player then actually played never synced at all.
  it('a REPUBLISHED word starts over, unfinished business included', async () => {
    seedRound({ startedAt: T0 - 300_000, deadline: T0 - 100_000, tried: ['mer'], claimed: 1 });
    post.mockResolvedValueOnce(answer(200, { startedAt: at(0), nowAt: 300_000 }));
    post.mockRejectedValueOnce(new Error('offline')); // the retired run's log never lands
    beginWordRoundSync(ctx(), true);
    await settle();
    expect(round().submitted).toBeUndefined();

    // The daily is re-published with a different word: the store resets the round, and the
    // conversation must forget the retired run's unfinished submission with it.
    useGameStore.setState(
      (s) => ({
        wordRounds: {
          ...s.wordRounds,
          [KEY]: { word: 'autre', startedAt: null, deadline: null, tried: [], claimed: 0 },
        },
      }),
      false,
    );
    post.mockReset();
    post.mockResolvedValueOnce(answer(404, { error: 'not_found' }));
    beginWordRoundSync({ ...ctx(), word: 'autre' }, false);
    await settle(120_000);
    // The read, and NOT a submission of the fresh round's empty log.
    expect(post).toHaveBeenCalledTimes(1);
    expect(bodyOf(0).guesses).toBeUndefined();
  });

  it('never re-anchors a clock this device is already running', async () => {
    seedRound({ startedAt: T0 - 5_000, deadline: T0 - 5_000 + runMs(0) });
    post.mockResolvedValueOnce(answer(200, { startedAt: at(0), nowAt: 40_000 }));
    beginWordRoundSync(ctx(), false);
    await settle();
    // A re-read must not shift a run under the player.
    expect(round()).toMatchObject({ startedAt: T0 - 5_000 });
  });
});

describe('the end-of-run SUBMISSION', () => {
  it('sends the whole log ONCE, after the read, and persists the acknowledgement', async () => {
    seedRound({ startedAt: T0 - 300_000, deadline: T0 - 100_000, tried: ['mer', 'loin'], claimed: 1 });
    post.mockResolvedValueOnce(answer(200, { startedAt: at(0), nowAt: 300_000 }));
    post.mockResolvedValueOnce(
      answer(200, { startedAt: at(0), nowAt: 300_000, guesses: ['mer', 'loin'] }),
    );
    beginWordRoundSync(ctx(), true);
    await settle();

    expect(post).toHaveBeenCalledTimes(2);
    expect(bodyOf(1).guesses).toEqual(['mer', 'loin']);
    expect(round().submitted).toBe(true);

    // A revisit re-reads (cross-device history) but owes nothing more.
    resetWordRoundSync();
    post.mockResolvedValueOnce(
      answer(200, { startedAt: at(0), nowAt: 600_000, guesses: ['mer', 'loin'] }),
    );
    beginWordRoundSync(ctx(), true);
    await settle();
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('answers "already submitted" the same way: the FIRST run recorded is the one that stands', async () => {
    seedRound({ startedAt: T0 - 300_000, deadline: T0 - 100_000, tried: ['mer'], claimed: 1 });
    post.mockResolvedValueOnce(answer(200, { startedAt: at(0), nowAt: 300_000 }));
    post.mockResolvedValueOnce(
      answer(200, { startedAt: at(0), nowAt: 300_000, guesses: ['ocean'] }),
    );
    beginWordRoundSync(ctx(), true);
    await settle();
    expect(round().submitted).toBe(true);
    // This device played its own run, so the recorded one does NOT overwrite the board it
    // is looking at — adopting a longer log would move a deadline that has already passed.
    expect(round().tried).toEqual(['mer']);
  });

  it('WAITS OUT a too_early refusal — it is an answer about when, not about the request', async () => {
    seedRound({ startedAt: T0 - 300_000, deadline: T0 - 100_000, tried: ['mer'], claimed: 1 });
    post.mockResolvedValueOnce(answer(200, { startedAt: at(0), nowAt: 300_000 }));
    post.mockResolvedValueOnce(answer(409, { startedAt: at(0), error: 'too_early' }));
    beginWordRoundSync(ctx(), true);
    await settle();
    expect(round().submitted).toBeUndefined();

    post.mockResolvedValueOnce(answer(200, { startedAt: at(0), guesses: ['mer'] }));
    await settle(60_000);
    expect(round().submitted).toBe(true);
  });

  it('CLOSES on a verdict — a run the server never started can never accept this log', async () => {
    seedRound({ startedAt: T0 - 300_000, deadline: T0 - 100_000, tried: ['mer'], claimed: 1 });
    post.mockResolvedValueOnce(answer(404, { error: 'not_found' }));
    post.mockResolvedValueOnce(answer(409, { error: 'not_started' }));
    beginWordRoundSync(ctx(), true);
    await settle();
    expect(post).toHaveBeenCalledTimes(2);
    // Nothing spins: a request this client keeps getting wrong is not retried for the
    // tab's life.
    await settle(120_000);
    expect(post).toHaveBeenCalledTimes(2);
    expect(round().submitted).toBeUndefined();
  });

  it('retries a transport failure behind a widening backoff', async () => {
    seedRound({ startedAt: T0 - 300_000, deadline: T0 - 100_000, tried: ['mer'], claimed: 1 });
    post.mockResolvedValueOnce(answer(200, { startedAt: at(0), nowAt: 300_000 }));
    post.mockRejectedValueOnce(new Error('offline'));
    beginWordRoundSync(ctx(), true);
    await settle();
    expect(post).toHaveBeenCalledTimes(2);
    expect(round().submitted).toBeUndefined();

    post.mockResolvedValueOnce(answer(200, { startedAt: at(0), guesses: ['mer'] }));
    await settle(60_000);
    expect(round().submitted).toBe(true);
  });

  // A device that JOINED a run — a second device under the same key, or a second tab
  // holding a stale copy — anchors the server's start with an empty log and cannot know
  // what the real run has claimed, so its clock dies at the bare START_SECONDS while the
  // run is still being played. Both writes are first-write-wins, so an empty submission
  // there would record an empty run (and a score of 0) that the real one can never replace.
  it('a JOINER writes nothing: it has no run of its own to report', async () => {
    seedRound();
    // The server's start is 2 minutes old and holds no log: the run is live elsewhere.
    post.mockResolvedValueOnce(answer(200, { startedAt: at(0), nowAt: 120_000 }));
    beginWordRoundSync(ctx(), false);
    await settle();
    // Its clock is already spent — that is what the screen will read as "over".
    expect(round().deadline!).toBeLessThan(T0);

    beginWordRoundSync(ctx(), true);
    await settle(120_000);
    expect(post).toHaveBeenCalledTimes(1); // the read, and nothing else
    expect(round().submitted).toBeUndefined();
  });

  it('…but the session that STARTED the run may report an empty one', async () => {
    seedRound();
    post.mockResolvedValueOnce(answer(200, { startedAt: at(0), nowAt: 0 }));
    await startWordRound(ctx()); // PLAY was tapped HERE
    expect(startedRunHere(KEY)).toBe(true);

    // Played nothing, waited out the clock: a real 0-claim run, and it still counts as
    // played.
    post.mockResolvedValueOnce(answer(200, { startedAt: at(0), nowAt: 60_000 }));
    post.mockResolvedValueOnce(answer(200, { startedAt: at(0), nowAt: 60_000 }));
    beginWordRoundSync(ctx(), true);
    await settle();
    expect(bodyOf(2).guesses).toEqual([]);
    expect(round().submitted).toBe(true);
  });

  it('says nothing at all while the run is still on', async () => {
    seedRound({ startedAt: T0, deadline: T0 + runMs(0), tried: ['mer'], claimed: 1 });
    post.mockResolvedValueOnce(answer(200, { startedAt: at(0) }));
    beginWordRoundSync(ctx(), false);
    await settle(60_000);
    // The read, and nothing else: Word mode does not stream.
    expect(post).toHaveBeenCalledTimes(1);
  });
});
