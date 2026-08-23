// CONTRACT (#211): the private player history is what the summary surfaces read now that
// #214 has removed the persisted sentence round. Two rules carry the whole issue:
//
//   1. LOADING IS EXPLICIT. A month that has not arrived is UNKNOWN, never a collection of
//      "not started" days — "nothing was played here" is a claim, and a false one paints a
//      whole calendar as untouched.
//   2. The STREAK's collection is the server's, and the client half only ever CREDITS: an
//      archive replay never touches it, a day already held is never counted twice, and a
//      collection that has not arrived celebrates nothing rather than guessing a previous
//      value.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PlayerHistory } from '@whippin/shared';

// The transport is stubbed, the READING is not: `parsePlayerHistory` and the whole commit
// path stay real, because what these tests are about is what an ANSWER does to the store.
const harness = vi.hoisted(() => ({
  answer: { days: [], solvedDays: [] } as PlayerHistory,
  // Whether THIS DEVICE has an identity (#216). With none, a private read is skipped
  // outright: an identity that was never bootstrapped owns no server rows, so its calendar
  // and streak are known-empty and asking would be a request on a visit that never acted.
  identity: true as boolean,
  // Every body the transport saw, so the collection opt-out is asserted on the wire shape.
  requests: [] as Array<Record<string, unknown>>,
  fail: false,
  // Scripted responders, consumed first-in-first-out before the default behavior — what
  // lets one test hold a flight in the air while another lands.
  script: [] as Array<() => Promise<Response>>,
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    historyUrl: () => 'https://test.invalid/history',
    postHistoryBody: async (_url: string, body: Record<string, unknown>) => {
      harness.requests.push(body);
      const scripted = harness.script.shift();
      if (scripted) return scripted();
      if (harness.fail) return { ok: false, status: 500 } as unknown as Response;
      return { ok: true, json: async () => harness.answer } as unknown as Response;
    },
  };
});

vi.mock('../identity', () => ({
  deviceIdentity: () =>
    harness.identity
      ? { token: 'f'.repeat(64), accountId: 'a'.repeat(16), deviceId: 'd'.repeat(16) }
      : null,
  identityEpoch: () => (harness.identity ? `${'a'.repeat(16)}:${'d'.repeat(16)}` : null),
  markDeviceSignedOut: vi.fn(),
}));

const { daySummaryStatus, loadPlayerHistory, noteSolvedDay, resetPlayerHistory, useHistoryStore } =
  await import('./history');
type HistoryView = import('./history').HistoryView;

beforeEach(() => {
  resetPlayerHistory();
  harness.answer = { days: [], solvedDays: [] };
  harness.identity = true;
  harness.requests = [];
  harness.fail = false;
  harness.script = [];
});

// One real read, landing with the server list given.
async function adoptServerAnswer(lang: string, solvedDays: number[]): Promise<void> {
  harness.answer = { days: [], solvedDays };
  await loadPlayerHistory(lang, 'sentence', undefined);
}

// A view as `usePlayerHistory` would return it, minus the hook.
function view(days: HistoryView['days'], daysPhase: HistoryView['daysPhase']): HistoryView {
  return { days, daysPhase, solvedDays: null, solvedPhase: 'idle', retry: () => {} };
}

describe('daySummaryStatus — a month that has not arrived is UNKNOWN, not "not started"', () => {
  it('is unknown-and-waiting while the read is in flight', () => {
    expect(daySummaryStatus(view(null, 'loading'), '2026-08-03')).toEqual({
      kind: 'unknown',
      loading: true,
    });
  });

  it('is unknown-and-still once the read has FAILED — there is no local fallback', () => {
    expect(daySummaryStatus(view(null, 'failed'), '2026-08-03')).toEqual({
      kind: 'unknown',
      loading: false,
    });
  });

  // IDLE claims nothing either — and it does NOT breathe: `loading` means a read is in
  // flight, so a surface with no request behind it rests still rather than promising an
  // answer that nobody asked for.
  it('is unknown before anything has asked, so an idle surface claims nothing either', () => {
    expect(daySummaryStatus(view(null, 'idle'), '2026-08-03')).toEqual({
      kind: 'unknown',
      loading: false,
    });
  });

  it('a day the ARRIVED month does not name is NONE — the server holds no round for it', () => {
    const days = new Map([['2026-08-03', { progress: 40, solved: false }]]);
    expect(daySummaryStatus(view(days, 'ready'), '2026-08-04')).toEqual({ kind: 'none' });
  });

  it('renders the summary the server derived: progress, and solved as solved', () => {
    const days = new Map([
      ['2026-08-03', { progress: 41.7, solved: false }],
      ['2026-08-04', { progress: 100, solved: true }],
    ]);
    expect(daySummaryStatus(view(days, 'ready'), '2026-08-03')).toEqual({
      kind: 'progress',
      pct: 42,
    });
    expect(daySummaryStatus(view(days, 'ready'), '2026-08-04')).toEqual({ kind: 'solved' });
  });

  it('a CAPPED round stays unsolved and keeps its percentage (#214)', () => {
    // The cap changes the RESULT's headline, never the day's fill.
    const days = new Map([['2026-08-05', { progress: 63, solved: false }]]);
    expect(daySummaryStatus(view(days, 'ready'), '2026-08-05')).toEqual({
      kind: 'progress',
      pct: 63,
    });
  });
});

describe('noteSolvedDay — the streak credit the celebration rides', () => {
  const held = (lang: string) => useHistoryStore.getState().solved[lang]?.days;
  const loaded = (lang: string, days: number[]) =>
    useHistoryStore.setState((state) => ({
      solved: { ...state.solved, [lang]: { phase: 'ready' as const, days } },
    }));

  it('inserts a CREDITED solve, sorted into what the collection already holds', () => {
    loaded('fr', [11]);
    expect(noteSolvedDay('fr', 12, true)).toBe(true);
    expect(held('fr')).toEqual([11, 12]);
  });

  it('a same-day second call credits nothing — a re-solve never counts twice', () => {
    loaded('fr', []);
    expect(noteSolvedDay('fr', 12, true)).toBe(true);
    expect(noteSolvedDay('fr', 12, true)).toBe(false);
    expect(held('fr')).toEqual([12]);
  });

  // ON TIME means ON THE DAY (user-decided 2026-08-23), and `credited` is the SERVER's own
  // verdict, carried on the confirming append's answer: an archive replay and a solve
  // carried past the 22:00 flip both come back uncredited, and the client no longer
  // re-makes the comparison on its own clock — a fast device inside the route's skew
  // window would otherwise celebrate a phantom day the union merge can never remove.
  it('an UNCREDITED solve credits nothing — the server\'s verdict is final', () => {
    loaded('fr', [12]);
    expect(noteSolvedDay('fr', 5, false)).toBe(false); // an archive replay
    expect(noteSolvedDay('fr', 11, false)).toBe(false); // the flip-edge is late too
    expect(held('fr')).toEqual([12]);
  });

  it('a collection that has NOT ARRIVED credits nothing and celebrates nothing', () => {
    // The choreography counts the PREVIOUS streak off this collection, and there is no
    // honest way to guess it — the server records the solve either way.
    expect(noteSolvedDay('fr', 12, true)).toBe(false);
    expect(held('fr')).toBeUndefined();
  });

  it('SURVIVES a revalidation that started before it', async () => {
    // The read was issued against a log the solving append had not reached, so its answer
    // does not name today — and it lands AFTER the credit. Replacing would take the day
    // straight back out from under a mounted StreakDialog, which counts its transition off
    // exactly this array. Within a language the collection only ever grows, so the union is
    // the honest reconciliation as well as the safe one.
    loaded('fr', [11]);
    expect(noteSolvedDay('fr', 12, true)).toBe(true);
    await adoptServerAnswer('fr', [11]);
    expect(held('fr')).toEqual([11, 12]);
  });

  it('adopts days the server knows that this device does not', async () => {
    // The union runs both ways: another device's solves arrive through the same answer.
    loaded('fr', [12]);
    await adoptServerAnswer('fr', [10, 11]);
    expect(held('fr')).toEqual([10, 11, 12]);
  });

  it('an answer that changes NOTHING keeps the collection\'s array identity', async () => {
    // StreakDialog's master sequence effect depends on arrays derived from this one, so a
    // read landing mid-celebration with nothing new must not mint a fresh identity — that
    // restarted the whole celebration from the opening fade.
    loaded('fr', [11, 12]);
    const before = held('fr');
    await adoptServerAnswer('fr', [11]);
    expect(held('fr')).toBe(before);
  });

  it('is per-language — an fr solve does not touch en', () => {
    loaded('fr', []);
    loaded('en', []);
    noteSolvedDay('fr', 12, true);
    expect(held('fr')).toEqual([12]);
    expect(held('en')).toEqual([]);
  });

  it('bounds the collection to MAX_SOLVED_DAYS, dropping the oldest', () => {
    const CAP = 800;
    loaded(
      'fr',
      Array.from({ length: CAP }, (_, i) => i + 1),
    );
    expect(noteSolvedDay('fr', CAP + 1, true)).toBe(true);
    const days = held('fr')!;
    expect(days.length).toBe(CAP);
    expect(days[0]).toBe(2);
    expect(days[days.length - 1]).toBe(CAP + 1);
  });
});

describe('loadPlayerHistory — the collection opt-out and the phase driver', () => {
  const solvedOf = (lang: string) => useHistoryStore.getState().solved[lang];

  it('collection: false skips the solved-day read and says so on the wire', async () => {
    await loadPlayerHistory('fr', 'sentence', '2026-08', false);
    expect(harness.requests).toEqual([{ token: 'f'.repeat(64), collection: false }]);
    // The flight leaves the solved entry entirely alone — phase included.
    expect(solvedOf('fr')).toBeUndefined();
    expect(useHistoryStore.getState().months['fr:sentence:2026-08']?.phase).toBe('ready');
  });

  it('a collection-reading flight omits the flag — the old body shape keeps its meaning', async () => {
    await loadPlayerHistory('fr', 'sentence', undefined);
    expect(harness.requests).toEqual([{ token: 'f'.repeat(64) }]);
  });

  it('a stale flight\'s failure cannot stamp FAILED over a collection another read drives', async () => {
    // Two flights race: the OLD month's read fails and lands LAST. Only the most recently
    // started collection read drives the lang-wide phase, so the stale failure fails its
    // own month and leaves the collection's phase to the read that owns it.
    let releaseOld!: () => void;
    const oldFlightGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    harness.script.push(async () => {
      await oldFlightGate;
      return { ok: false, status: 500 } as unknown as Response;
    });
    const oldFlight = loadPlayerHistory('fr', 'sentence', '2026-07');
    harness.answer = { days: [], solvedDays: [20_000] };
    await loadPlayerHistory('fr', 'sentence', '2026-08');
    expect(solvedOf('fr')).toEqual({ phase: 'ready', days: [20_000] });
    releaseOld();
    await oldFlight;
    // The stale failure fails its own MONTH, never the collection.
    expect(useHistoryStore.getState().months['fr:sentence:2026-07']?.phase).toBe('failed');
    expect(solvedOf('fr')?.phase).toBe('ready');
    expect(solvedOf('fr')?.days).toEqual([20_000]);
  });
});

describe('no token, no fetch (#216)', () => {
  it('answers a tokenless device known-EMPTY without asking the server', async () => {
    // An identity that was never bootstrapped owns no server rows, so its calendar and its
    // streak are answers this client already has. Asking would be a private read on a visit
    // that has performed none of the deliberate acts that create an identity.
    harness.identity = false;
    harness.answer = { days: [{ date: '2026-08-03', progress: 42, solved: false }], solvedDays: [7] };
    await loadPlayerHistory('fr', 'sentence', '2026-08');

    const state = useHistoryStore.getState();
    const month = state.months['fr:sentence:2026-08'];
    // READY with real values, never `idle` or a pending null: an unarrived month BREATHES,
    // and a placeholder breathing forever behind a request nobody made is the exact false
    // promise the explicit-loading rule exists to prevent.
    expect(month?.phase).toBe('ready');
    expect(month?.days?.size).toBe(0);
    expect(state.solved.fr).toEqual({ phase: 'ready', days: [] });
    expect(harness.requests).toEqual([]);
  });

  it('reads normally once the device HAS an identity', async () => {
    harness.identity = true;
    harness.answer = { days: [{ date: '2026-08-03', progress: 42, solved: false }], solvedDays: [7] };
    await loadPlayerHistory('fr', 'sentence', '2026-08');
    expect(useHistoryStore.getState().months['fr:sentence:2026-08']?.days?.size).toBe(1);
  });
});
