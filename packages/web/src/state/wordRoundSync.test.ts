// CONTRACT (#202, owned by a DEVICE since #217): Word mode's conversation with the server.
// The mode writes exactly TWICE — a Turnstile-gated START that stamps the round's clock
// from the SERVER's own clock FOR THIS DEVICE, and ONE end-of-run submission carrying the
// whole log — with a mount READ that writes nothing and says WHOSE run the daily holds.
//
//   - the visible clock is anchored to `now - startedAt`, an ELAPSED SPAN, so a skewed
//     device clock cannot shorten or lengthen a run — and the request's own travel time
//     lands INSIDE the run, which is the margin that keeps an honest submission clear of
//     the server's wait check;
//   - a START is a RESTART: it mints a fresh clock and the local run starts over with it,
//     and the client still asks ONCE however many times PLAY is tapped;
//   - the READ anchors NOTHING — a clock this device does not hold is a run whose claims it
//     cannot see — so it only reports the run's owner, which the SCREEN turns into a phase;
//   - a run that ended is submitted ONCE, truncated to what the route accepts; a 2xx
//     adopts the server's first-write-wins log and clears the persisted local outbox;
//   - `too_early` is waited out (it is an answer about WHEN); every other 4xx is a VERDICT
//     that closes the conversation instead of spinning on it — and one that carries state
//     (`started_elsewhere`) is ADOPTED on the way out, so the screen learns who holds the
//     run now.
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
  finishWordRound,
  resetWordRoundSync,
  startWordRound,
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

// This device's IDENTITY (#216). The engine's own tokenless branch — no identity means no
// private fetch at all — is exercised in `identity.test.ts`; here the device is signed in,
// which is what every case below is about.
const signedOut = vi.hoisted(() => vi.fn());
const identity = vi.hoisted(() => ({
  present: true,
  value: { token: 'f'.repeat(64), accountId: 'a'.repeat(16), deviceId: 'd'.repeat(16) },
  beforeEnsure: null as (() => void) | null,
}));
vi.mock('../identity', () => ({
  deviceIdentity: () => (identity.present ? identity.value : null),
  // The START's own resolver — the one word path that may MINT (#216 rework: PLAY is a
  // deploy button), which the mint here mimics by flipping `present` on.
  ensureRequestIdentity: async (expected: string | null) => {
    identity.beforeEnsure?.();
    identity.present = true;
    const epoch = `${identity.value.accountId}:${identity.value.deviceId}`;
    return expected !== null && expected !== epoch ? null : { identity: identity.value, epoch };
  },
  // The SUBMISSION's resolver — never mints (#216 rework).
  currentRequestIdentity: (expected: string | null = null) => {
    if (!identity.present) return null;
    const epoch = `${identity.value.accountId}:${identity.value.deviceId}`;
    if (expected !== null && expected !== epoch) return null;
    return { identity: identity.value, epoch };
  },
  identityEpoch: () =>
    identity.present ? `${identity.value.accountId}:${identity.value.deviceId}` : null,
  identityEpochOf: (value: { accountId: string; deviceId: string }) =>
    `${value.accountId}:${value.deviceId}`,
  markDeviceSignedOut: signedOut,
}));


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
  return { roundKey: KEY, lang: 'fr', date: '2026-08-21', word: WORD, ranks: RANKS };
}

// An instant on the SERVER's clock, `ms` after the fixed reference the answers are built
// around. The client's own clock is deliberately a different number.
const SERVER_T0 = Date.parse('2026-08-21T14:00:00.000Z');
const at = (ms: number) => new Date(SERVER_T0 + ms).toISOString();

// The two devices every ownership case is told apart by: this one (the identity mock's own
// id) and another of the same account.
const ME = { deviceId: 'd'.repeat(16), device: 'Test', os: 'Test', browser: 'Test' };
const OTHER = { deviceId: 'e'.repeat(16), device: 'iPhone', os: 'iOS 17', browser: 'Safari' };

function answer(
  status: number,
  body: {
    guesses?: string[];
    startedAt?: string;
    // WHO the server says holds the run (#217). A stamped clock always names a device.
    startedBy?: { deviceId: string; device: string; os: string; browser: string };
    submittedAt?: string;
    nowAt?: number;
    error?: string;
  },
) {
  const { nowAt = 0, ...rest } = body;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({
      guesses: rest.guesses ?? [],
      createdAt: at(0),
      ...(rest.startedAt ? { startedAt: rest.startedAt, startedBy: rest.startedBy ?? ME } : {}),
      ...(rest.submittedAt ? { submittedAt: rest.submittedAt } : {}),
      now: at(nowAt),
      ...(rest.error ? { error: rest.error, message: 'refused' } : {}),
    }),
  } as unknown as Response;
}

// A START that stamped the clock for THIS device — what PLAY gets back.
const stamped = (nowAt = 0) => answer(200, { startedAt: at(0), nowAt });

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

// The SCREEN's two calls (#217, replacing #202's `beginWordRoundSync(ctx, over)` flag):
// register the round, and — when the run THIS device holds has ended — report it. Whose run
// it is comes from the server's stamp read against this device's id, which is the screen's
// own decision to make.
function mount(context = ctx()): void {
  beginWordRoundSync(context);
}
function runOver(context = ctx()): void {
  beginWordRoundSync(context);
  finishWordRound(context);
}

const round = () => useGameStore.getState().wordRounds[KEY];
const load = () => useGameStore.getState().roundLoads[KEY];
const serverGuesses = () => {
  const current = load();
  return current?.status === 'ready' ? current.server.guesses : undefined;
};

function bodyOf(call: number) {
  return post.mock.calls[call][1] as {
    token: string;
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
  signedOut.mockReset();
  identity.value = {
    token: 'f'.repeat(64),
    accountId: 'a'.repeat(16),
    deviceId: 'd'.repeat(16),
  };
  identity.beforeEnsure = null;
  identity.present = true;
  useGameStore.setState(
    { outbox: {}, wordRounds: {}, roundLoads: {}, activeWordKey: null },
    false,
  );
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
  const state = (startedAt: string | null, nowAt: number) => ({
    guesses: [],
    createdAt: at(0),
    startedAt,
    startedBy: startedAt === null ? null : ME,
    submittedAt: null,
    now: at(nowAt),
    solved: false,
    credited: false,
  });

  it('holds the ELAPSED span, so a device clock hours off still runs one minute', () => {
    // The server says 20s have passed. Whatever this device thinks the date is, the run
    // has 40 of its 60 seconds left.
    expect(anchorFrom(state(at(0), 20_000), T0)).toBe(T0 - 20_000);
    // Skewing the device clock by an hour moves the anchor with it, never the span.
    expect(anchorFrom(state(at(0), 20_000), T0 + 3_600_000)).toBe(T0 + 3_600_000 - 20_000);
  });

  it('is null when no run has been started', () => {
    expect(anchorFrom(state(null, 0), T0)).toBeNull();
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
  it('does not start A\'s captured round as B when ensure adopts a replacement identity', async () => {
    seedRound();
    identity.beforeEnsure = () => {
      identity.value = {
        token: '8'.repeat(64),
        accountId: 'b'.repeat(16),
        deviceId: 'e'.repeat(16),
      };
    };

    await expect(startWordRound(ctx())).resolves.toBe(false);
    expect(challenge).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(round()).toMatchObject({ startedAt: null, tried: [] });
  });

  it('asks for a challenge and anchors the clock the SERVER stamped', async () => {
    seedRound();
    const started = startWordRound(ctx());
    post.mockResolvedValueOnce(stamped());
    await expect(started).resolves.toBe(true);

    expect(bodyOf(0)).toMatchObject({ puzzle: wordTag(WORD), turnstileToken: 'token' });
    // Nothing is sent as a guess: the start writes a clock, not a log.
    expect(bodyOf(0).guesses).toBeUndefined();
    expect(round()).toMatchObject({ startedAt: T0, deadline: T0 + runMs(0) });
  });

  // #202 RESUMED here; #217 restarts instead. Resuming a run whose claims live in another
  // device's storage was never really resuming it — Word mode streams nothing, so they are
  // unreachable until that device submits — so what a second device can honestly offer is a
  // fresh run, and the answer's clock is the one the server just minted.
  it('RESTARTS: the answer opens a fresh run, wiping the local one it replaces', async () => {
    seedRound({ startedAt: T0 - 40_000, deadline: T0 - 40_000 + runMs(1), tried: ['mer'], claimed: 1 });
    post.mockResolvedValueOnce(stamped());
    await startWordRound(ctx());
    expect(round()).toMatchObject({
      startedAt: T0,
      deadline: T0 + runMs(0),
      tried: [],
      claimed: 0,
    });
  });

  // The start ANSWER carries the run's owner, which is what the screen reads its phase
  // from — including the case that used to need a session-scoped "I started this" flag.
  it('publishes the DEVICE the server stamped the run for', async () => {
    seedRound();
    post.mockResolvedValueOnce(answer(404, { error: 'not_found' })); // nobody had started it
    mount();
    await settle();

    post.mockResolvedValueOnce(stamped());
    await startWordRound(ctx());
    const current = load();
    expect(current?.status === 'ready' && current.server.startedBy).toEqual(ME);
  });

  // The one thing a start cannot do: reopen a day whose log is stored. The server refuses
  // it and answers with the run that stands, so the gate is released onto the final screen
  // instead of a clock the recorded score could never belong to.
  it('ADOPTS a recorded run instead of opening a clock over it', async () => {
    seedRound();
    // The read found nothing; between it and the tap, another device finished the day.
    post.mockResolvedValueOnce(answer(404, { error: 'not_found' }));
    mount();
    await settle();

    post.mockResolvedValueOnce(
      answer(200, {
        startedAt: at(0),
        startedBy: OTHER,
        submittedAt: at(90_000),
        nowAt: 120_000,
        guesses: ['mer'],
      }),
    );
    await expect(startWordRound(ctx())).resolves.toBe(true);
    expect(round()).toMatchObject({ submitted: true, tried: [], claimed: 1 });
    expect(round().startedAt).toBeNull();
    expect(serverGuesses()).toEqual(['mer']);
  });

  it('is ONE challenge and ONE write however many times PLAY is tapped', async () => {
    seedRound();
    post.mockResolvedValue(stamped());
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
    post.mockResolvedValueOnce(stamped());
    await expect(startWordRound(ctx())).resolves.toBe(true);
    expect(round().startedAt).toBe(T0);
  });

  it('raises signed-out from PLAY only for the `unknown_device` error code', async () => {
    seedRound();
    post.mockResolvedValueOnce(answer(401, { error: 'unknown_device' }));
    await expect(startWordRound(ctx())).resolves.toBe(false);
    expect(signedOut).toHaveBeenCalledWith(`${'a'.repeat(16)}:${'d'.repeat(16)}`);

    signedOut.mockReset();
    post.mockResolvedValueOnce(answer(401, { error: 'not_started' }));
    await expect(startWordRound(ctx())).resolves.toBe(false);
    expect(signedOut).not.toHaveBeenCalled();
  });

  // The same key reuse makes the in-flight map ambiguous: a start still in the air for the
  // retired word would otherwise answer a call about the replacement with ITS outcome, and
  // open the retired word's clock into the fresh round.
  it('drops a START answer for a word the round no longer plays', async () => {
    seedRound();
    let settleStart: (value: Response) => void = () => {};
    post.mockReturnValueOnce(new Promise<Response>((resolve) => { settleStart = resolve; }));
    const inFlight = startWordRound(ctx());

    // The daily is re-published while the request is in the air.
    useGameStore.setState(
      (state) => ({
        wordRounds: {
          ...state.wordRounds,
          [KEY]: { word: 'autre', startedAt: null, deadline: null, tried: [], claimed: 0 },
        },
      }),
      false,
    );
    settleStart(stamped());
    await expect(inFlight).resolves.toBe(false);
    // The retired word's clock never reaches the round now on screen.
    expect(round()).toMatchObject({ word: 'autre', startedAt: null, deadline: null });
  });

  it('reports failure when the challenge itself never lands', async () => {
    seedRound();
    challenge.mockRejectedValueOnce(new Error('blocked'));
    await expect(startWordRound(ctx())).resolves.toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
});

describe('the mount READ', () => {
  it('publishes a loading state qualified by this word before the read settles', () => {
    seedRound();
    post.mockReturnValueOnce(new Promise(() => {}));
    mount();
    expect(load()).toEqual({ status: 'loading', puzzle: wordTag(WORD) });
  });

  // #202 anchored the server's clock here, which is what made the daily one-shot across
  // devices. #217 stops: a run this device does not hold is one whose claims live in the
  // playing device's storage, so a countdown opened for it would time a log that can never
  // be reported. What the read does instead is NAME the owner.
  it('ANCHORS NOTHING, and reports whose run the daily holds', async () => {
    seedRound();
    post.mockResolvedValueOnce(answer(200, { startedAt: at(0), startedBy: OTHER, nowAt: 30_000 }));
    mount();
    await settle();
    expect(bodyOf(0).guesses).toBeUndefined();
    expect(round()).toMatchObject({ startedAt: null, deadline: null });
    const current = load();
    expect(current?.status === 'ready' && current.server.startedBy).toEqual(OTHER);
  });

  // The same rule for a stamp naming THIS device: the local clock is the only place a run's
  // claims exist, so a device whose storage no longer holds one is offered a restart rather
  // than a countdown over a log it cannot see. (The screen reads exactly that pair.)
  it('opens no clock even when the stamp names this device', async () => {
    seedRound();
    post.mockResolvedValueOnce(answer(200, { startedAt: at(0), nowAt: 30_000 }));
    mount();
    await settle();
    expect(round()).toMatchObject({ startedAt: null, deadline: null });
  });

  it('carries a finished day’s RECORDED run to a device that never played it', async () => {
    seedRound();
    post.mockResolvedValueOnce(
      answer(200, {
        startedAt: at(0),
        submittedAt: at(200_000),
        nowAt: 300_000,
        guesses: ['mer', 'loin'],
      }),
    );
    mount();
    await settle();
    expect(round()).toMatchObject({ tried: [], claimed: 1, submitted: true });
    expect(serverGuesses()).toEqual(['mer', 'loin']);
    // No clock is opened for it (#217): the run is recorded, and `submitted` is the whole
    // fact the screen needs to draw the final result.
    expect(round().deadline).toBeNull();
    // …and the server demonstrably holds it, so nothing is owed. Without this the device
    // would POST the adopted run straight back on this visit and on every later one.
    expect(round().submitted).toBe(true);

    runOver();
    await settle(60_000);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('ends a still-live local phase when the mount read finds a submitted run', async () => {
    seedRound({
      startedAt: T0,
      deadline: T0 + runMs(3),
      tried: ['mer'],
      claimed: 1,
    });
    post.mockResolvedValueOnce(
      answer(200, {
        startedAt: at(0),
        submittedAt: at(10_000),
        nowAt: 10_000,
        guesses: ['ocean'],
      }),
    );

    mount();
    await settle();

    expect(round()).toMatchObject({
      deadline: T0,
      tried: [],
      claimed: 1,
      submitted: true,
    });
    expect(serverGuesses()).toEqual(['ocean']);
  });

  // The marker is `submittedAt`, never the log's LENGTH: a run that claimed nothing is
  // recorded as an EMPTY log, which reads exactly like an unsubmitted one. Keyed on the
  // length, such a day would look unrecorded on every visit forever.
  it('recognises a recorded 0-claim run, whose log is empty', async () => {
    seedRound();
    post.mockResolvedValueOnce(
      answer(200, { startedAt: at(0), submittedAt: at(90_000), nowAt: 300_000 }),
    );
    runOver();
    await settle(120_000);
    expect(round().submitted).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('leaves an unplayed day alone on a 404 — PLAY is what creates the record', async () => {
    seedRound();
    post.mockResolvedValueOnce(answer(404, { error: 'not_found' }));
    mount();
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
    runOver();
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
    mount({ ...ctx(), word: 'autre' });
    expect(load()).toEqual({ status: 'loading', puzzle: wordTag('autre') });
    await settle(120_000);
    // The read, and NOT a submission of the fresh round's empty log.
    expect(post).toHaveBeenCalledTimes(1);
    expect(bodyOf(0).guesses).toBeUndefined();
  });

  it('never shifts a clock this device is already running', async () => {
    seedRound({ startedAt: T0 - 5_000, deadline: T0 - 5_000 + runMs(0) });
    post.mockResolvedValueOnce(answer(200, { startedAt: at(0), nowAt: 40_000 }));
    mount();
    await settle();
    // A re-read must not shift a run under the player — only a START ever writes the clock.
    expect(round()).toMatchObject({ startedAt: T0 - 5_000, deadline: T0 - 5_000 + runMs(0) });
  });
});

describe('the end-of-run SUBMISSION', () => {
  it('a TOKENLESS submission stands down — only the deploy buttons mint (#216 rework)', async () => {
    // A run this identity cannot own: the persisted log exists but the device holds no
    // account (the pending-bootstrap edge). The submission never mints one — the mount
    // read publishes ready-and-empty without a request, and the write stands down, so
    // nothing here ever reaches the server. (The old mid-ensure identity-swap hazard is
    // structurally gone: the submission resolves its identity synchronously now.)
    seedRound({
      startedAt: T0 - 300_000,
      deadline: T0 - 100_000,
      tried: ['mer'],
      claimed: 1,
    });
    identity.present = false;
    runOver();
    await settle();

    expect(post).not.toHaveBeenCalled();
    expect(round().tried).toEqual(['mer']);
  });

  it('sends the whole log ONCE, after the read, and persists the acknowledgement', async () => {
    seedRound({ startedAt: T0 - 300_000, deadline: T0 - 100_000, tried: ['mer', 'loin'], claimed: 1 });
    post.mockResolvedValueOnce(answer(200, { startedAt: at(0), nowAt: 300_000 }));
    post.mockResolvedValueOnce(
      answer(200, { startedAt: at(0), nowAt: 300_000, guesses: ['mer', 'loin'] }),
    );
    runOver();
    await settle();

    expect(post).toHaveBeenCalledTimes(2);
    expect(bodyOf(1).guesses).toEqual(['mer', 'loin']);
    expect(round()).toMatchObject({ submitted: true, tried: [] });
    expect(serverGuesses()).toEqual(['mer', 'loin']);

    // A revisit re-reads (cross-device history) but owes nothing more.
    resetWordRoundSync();
    post.mockResolvedValueOnce(
      answer(200, { startedAt: at(0), nowAt: 600_000, guesses: ['mer', 'loin'] }),
    );
    runOver();
    await settle();
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('answers "already submitted" the same way: the FIRST run recorded is the one that stands', async () => {
    seedRound({ startedAt: T0 - 300_000, deadline: T0 - 100_000, tried: ['loin'], claimed: 0 });
    post.mockResolvedValueOnce(answer(200, { startedAt: at(0), nowAt: 300_000 }));
    post.mockResolvedValueOnce(
      answer(200, { startedAt: at(0), nowAt: 300_000, guesses: ['ocean'] }),
    );
    runOver();
    await settle();
    expect(bodyOf(1).guesses).toEqual(['loin']);
    expect(round()).toMatchObject({ submitted: true, tried: [], claimed: 1 });
    // The server's FIRST run replaces what this device displayed; persisted `tried` is
    // only the acknowledged outbox, and the authoritative log stays transient.
    expect(serverGuesses()).toEqual(['ocean']);
  });

  it('WAITS OUT a too_early refusal — it is an answer about when, not about the request', async () => {
    seedRound({ startedAt: T0 - 300_000, deadline: T0 - 100_000, tried: ['mer'], claimed: 1 });
    post.mockResolvedValueOnce(answer(200, { startedAt: at(0), nowAt: 300_000 }));
    post.mockResolvedValueOnce(answer(409, { startedAt: at(0), error: 'too_early' }));
    runOver();
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
    runOver();
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
    runOver();
    await settle();
    expect(post).toHaveBeenCalledTimes(2);
    expect(round().submitted).toBeUndefined();

    post.mockResolvedValueOnce(answer(200, { startedAt: at(0), guesses: ['mer'] }));
    await settle(60_000);
    expect(round().submitted).toBe(true);
  });

  // A run that claimed NOTHING is still a run somebody played, and it records. #202 needed a
  // session flag to allow it (an empty local log looked exactly like a joiner's); #217 needs
  // none, because a device only ever reports the run its own screen was holding.
  it('reports an EMPTY run — playing nothing is a result, not an absence', async () => {
    seedRound();
    post.mockResolvedValueOnce(stamped());
    await startWordRound(ctx()); // PLAY was tapped HERE
    post.mockResolvedValueOnce(answer(200, { startedAt: at(0), nowAt: 60_000 }));
    post.mockResolvedValueOnce(answer(200, { startedAt: at(0), nowAt: 60_000 }));
    runOver();
    await settle();
    expect(bodyOf(2).guesses).toEqual([]);
    expect(round().submitted).toBe(true);
  });

  // The screen reports the run it HOLDS, and only that: a device that never started this
  // day, or one whose run was restarted elsewhere, is on the gate and says nothing. Nothing
  // in the engine has to infer it any more.
  it('says nothing for a run the screen never reports over', async () => {
    seedRound();
    post.mockResolvedValueOnce(answer(200, { startedAt: at(0), startedBy: OTHER, nowAt: 120_000 }));
    mount();
    await settle(120_000);
    expect(post).toHaveBeenCalledTimes(1); // the read, and nothing else
    expect(round().submitted).toBeUndefined();
  });

  // Last-commit-wins between concurrent devices (#217): device B restarted the day while
  // this one was away, so the log offered here belongs to a clock the server no longer
  // holds. The refusal is a VERDICT — retrying cannot make it accept — but it also carries
  // the stamp that STANDS, and adopting that is what moves this screen off a finished run
  // it may never report and onto the offer to start over.
  it('ADOPTS a `started_elsewhere` refusal on the way out, and stops asking', async () => {
    seedRound({ startedAt: T0 - 300_000, deadline: T0 - 100_000, tried: ['mer'], claimed: 1 });
    post.mockResolvedValueOnce(answer(200, { startedAt: at(0), nowAt: 300_000 }));
    post.mockResolvedValueOnce(
      answer(409, { startedAt: at(200_000), startedBy: OTHER, error: 'started_elsewhere' }),
    );
    runOver();
    await settle();

    const current = load();
    expect(current?.status === 'ready' && current.server.startedBy).toEqual(OTHER);
    expect(round().submitted).toBeUndefined();
    // Nothing spins: the conversation is closed on the verdict.
    await settle(120_000);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('says nothing at all while the run is still on', async () => {
    seedRound({ startedAt: T0, deadline: T0 + runMs(0), tried: ['mer'], claimed: 1 });
    post.mockResolvedValueOnce(answer(200, { startedAt: at(0) }));
    mount();
    await settle(60_000);
    // The read, and nothing else: Word mode does not stream.
    expect(post).toHaveBeenCalledTimes(1);
  });
});
