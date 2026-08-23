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
const harness = vi.hoisted(() => ({ answer: { days: [], solvedDays: [] } as PlayerHistory }));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    historyUrl: () => 'https://test.invalid/history',
    postHistoryBody: async () =>
      ({ ok: true, json: async () => harness.answer }) as unknown as Response,
  };
});

const { daySummaryStatus, loadPlayerHistory, noteSolvedDay, resetPlayerHistory, useHistoryStore } =
  await import('./history');
type HistoryView = import('./history').HistoryView;

beforeEach(() => {
  resetPlayerHistory();
  harness.answer = { days: [], solvedDays: [] };
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

  it('inserts TODAY\'s solve, sorted into what the collection already holds', () => {
    loaded('fr', [11]);
    expect(noteSolvedDay('fr', 12, 12)).toBe(true);
    expect(held('fr')).toEqual([11, 12]);
  });

  it('a same-day second call credits nothing — a re-solve never counts twice', () => {
    loaded('fr', []);
    expect(noteSolvedDay('fr', 12, 12)).toBe(true);
    expect(noteSolvedDay('fr', 12, 12)).toBe(false);
    expect(held('fr')).toEqual([12]);
  });

  it('an ARCHIVE replay credits nothing, at any distance', () => {
    loaded('fr', [12]);
    expect(noteSolvedDay('fr', 5, 12)).toBe(false);
    expect(noteSolvedDay('fr', 11, 12)).toBe(false); // yesterday is an archive day too
    expect(held('fr')).toEqual([12]);
  });

  // ON TIME means ON THE DAY (user-decided 2026-08-23). A round carried across the 22:00
  // flip and finished at 22:00:01 was not finished on time — and it is numerically
  // identical to opening yesterday from the archive, which is exactly why one comparison
  // now answers both instead of a window plus a route gate.
  it('a solve carried PAST the 22:00 flip credits nothing', () => {
    loaded('fr', [11]);
    expect(noteSolvedDay('fr', 11, 12)).toBe(false);
    expect(held('fr')).toEqual([11]);
  });

  it('a collection that has NOT ARRIVED credits nothing and celebrates nothing', () => {
    // The choreography counts the PREVIOUS streak off this collection, and there is no
    // honest way to guess it — the server records the solve either way.
    expect(noteSolvedDay('fr', 12, 12)).toBe(false);
    expect(held('fr')).toBeUndefined();
  });

  it('SURVIVES a revalidation that started before it', async () => {
    // The read was issued against a log the solving append had not reached, so its answer
    // does not name today — and it lands AFTER the credit. Replacing would take the day
    // straight back out from under a mounted StreakDialog, which counts its transition off
    // exactly this array. Within a language the collection only ever grows, so the union is
    // the honest reconciliation as well as the safe one.
    loaded('fr', [11]);
    expect(noteSolvedDay('fr', 12, 12)).toBe(true);
    await adoptServerAnswer('fr', [11]);
    expect(held('fr')).toEqual([11, 12]);
  });

  it('adopts days the server knows that this device does not', async () => {
    // The union runs both ways: another device's solves arrive through the same answer.
    loaded('fr', [12]);
    await adoptServerAnswer('fr', [10, 11]);
    expect(held('fr')).toEqual([10, 11, 12]);
  });

  it('is per-language — an fr solve does not touch en', () => {
    loaded('fr', []);
    loaded('en', []);
    noteSolvedDay('fr', 12, 12);
    expect(held('fr')).toEqual([12]);
    expect(held('en')).toEqual([]);
  });

  it('bounds the collection to MAX_SOLVED_DAYS, dropping the oldest', () => {
    const CAP = 800;
    loaded(
      'fr',
      Array.from({ length: CAP }, (_, i) => i + 1),
    );
    expect(noteSolvedDay('fr', CAP + 1, CAP + 1)).toBe(true);
    const days = held('fr')!;
    expect(days.length).toBe(CAP);
    expect(days[0]).toBe(2);
    expect(days[days.length - 1]).toBe(CAP + 1);
  });
});
