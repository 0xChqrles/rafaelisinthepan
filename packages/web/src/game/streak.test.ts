// CONTRACT: streak derivation (packages/web/src/game/streak.ts, issue #56). The streak
// counters are DERIVED from the per-language SET of solved game days, never persisted:
//   - currentStreak = the consecutive run ending at the last solved day, but ONLY while
//     the streak is ALIVE (last solve is today or yesterday); a broken chain -> 0;
//   - bestStreak = the longest consecutive run ANYWHERE in the set (all-time best);
//   - both are pure over the day array and defensively sort + dedupe, so deriving from a
//     raw set UNION is order-independent + idempotent (the property the day-set exists
//     for — it makes a future cross-device merge a union + recompute).

import { describe, it, expect } from 'vitest';
import { currentStreak, bestStreak, streakTransition, weekView } from './streak';

// 2024-01-01 is a MONDAY; its dayNumber is a clean anchor for the Monday-based week math.
const MON = Math.floor(Date.UTC(2024, 0, 1) / 86_400_000);
const TUE = MON + 1;
const WED = MON + 2;
const SUN = MON + 6;

describe('currentStreak', () => {
  it('is 0 for an empty set', () => {
    expect(currentStreak([], 100)).toBe(0);
  });

  it('counts the consecutive run ending TODAY', () => {
    expect(currentStreak([8, 9, 10], 10)).toBe(3);
  });

  it('is ALIVE when yesterday was solved but today is still pending', () => {
    // Last solve is activeDay - 1: today is not yet required to keep a streak.
    expect(currentStreak([8, 9], 10)).toBe(2);
  });

  it('is 0 once the chain is broken (last solve older than yesterday)', () => {
    expect(currentStreak([8, 9], 12)).toBe(0);
  });

  it('counts only the tail run, not an earlier equal-or-longer one', () => {
    // Earlier run [1,2,3] is broken; the live run is [9,10].
    expect(currentStreak([1, 2, 3, 9, 10], 10)).toBe(2);
  });

  it('a single solved day today is a streak of 1', () => {
    expect(currentStreak([10], 10)).toBe(1);
  });
});

describe('streakTransition', () => {
  it('increments a live consecutive streak', () => {
    expect(streakTransition([8, 9, 10], 10)).toEqual({ previous: 2, next: 3 });
  });

  it('starts at 0 -> 1 when there was no live streak', () => {
    expect(streakTransition([5, 10], 10)).toEqual({ previous: 0, next: 1 });
  });

  it('starts at 0 -> 1 on the first-ever solve', () => {
    expect(streakTransition([10], 10)).toEqual({ previous: 0, next: 1 });
  });
});

describe('bestStreak', () => {
  it('is 0 for an empty set', () => {
    expect(bestStreak([])).toBe(0);
  });

  it('a single day is 1', () => {
    expect(bestStreak([42])).toBe(1);
  });

  it('finds the longest run ANYWHERE, not just the tail', () => {
    // Longest run is [1,2,3,4] (4), even though the set ends on a shorter [20,21].
    expect(bestStreak([1, 2, 3, 4, 10, 20, 21])).toBe(4);
  });

  it('counts a fully consecutive set as its length', () => {
    expect(bestStreak([5, 6, 7, 8, 9])).toBe(5);
  });
});

describe('merge-friendliness — the reason the day-set shape exists', () => {
  // A union of two devices' solved-day sets is deriving-order-independent and idempotent:
  // that is exactly why the streak persists the SET, not a counter (a counter can't merge).
  const A = [1, 2, 3, 10];
  const B = [3, 4, 11, 12]; // overlaps A on day 3, out of order

  it('is order-independent: A∪B derives the same as B∪A', () => {
    const activeDay = 12;
    expect(currentStreak([...A, ...B], activeDay)).toBe(currentStreak([...B, ...A], activeDay));
    expect(bestStreak([...A, ...B])).toBe(bestStreak([...B, ...A]));
  });

  it('is idempotent: re-including an already-present set changes nothing', () => {
    const activeDay = 12;
    const union = [...A, ...B];
    expect(currentStreak([...union, ...A], activeDay)).toBe(currentStreak(union, activeDay));
    expect(bestStreak([...union, ...B])).toBe(bestStreak(union));
  });

  it('derives the correct counters over the deduped union', () => {
    // union sorted+deduped = [1,2,3,4,10,11,12]; best run [1,2,3,4] = 4; current (activeDay
    // 12) = [10,11,12] = 3.
    const union = [...A, ...B];
    expect(bestStreak(union)).toBe(4);
    expect(currentStreak(union, 12)).toBe(3);
  });
});

describe('weekView — the Monday-based weekly row (#74)', () => {
  it('returns 7 cells, Monday-first, for the week containing the active day', () => {
    const { cells } = weekView([WED], WED);
    expect(cells).toHaveLength(7);
    expect(cells[0].dayNumber).toBe(MON); // Monday first
    expect(cells[6].dayNumber).toBe(SUN); // Sunday last
  });

  it('anchors the same week from ANY day in it (Monday, mid-week, and Sunday)', () => {
    // A Sunday active day still belongs to the Monday-starting week (not the next one).
    expect(weekView([MON], MON).cells[0].dayNumber).toBe(MON);
    expect(weekView([WED], WED).cells[0].dayNumber).toBe(MON);
    expect(weekView([SUN], SUN).cells[0].dayNumber).toBe(MON);
  });

  it('flags solved / today / future correctly on a clean partial week', () => {
    // First solve Monday, played through Wednesday (today); Thu..Sun still to come.
    const { clean, cells } = weekView([MON, TUE, WED], WED);
    expect(clean).toBe(true);
    expect(cells.map((c) => c.solved)).toEqual([true, true, true, false, false, false, false]);
    expect(cells.map((c) => c.isFuture)).toEqual([false, false, false, true, true, true, true]);
    expect(cells.find((c) => c.isToday)?.dayNumber).toBe(WED);
  });

  it('a full solved week is clean, all solved, none future', () => {
    const days = [MON, TUE, WED, MON + 3, MON + 4, MON + 5, SUN];
    const { clean, cells } = weekView(days, SUN);
    expect(clean).toBe(true);
    expect(cells.every((c) => c.solved)).toBe(true);
    expect(cells.some((c) => c.isFuture)).toBe(false);
  });

  it('a MISSED elapsed day on/after the first solve breaks clean', () => {
    // First solve Monday, today Wednesday, but Tuesday was missed -> not clean.
    const { clean } = weekView([MON, WED], WED);
    expect(clean).toBe(false);
  });

  it('pre-start days do NOT break clean — a mid-week newcomer still gets the row', () => {
    // First-ever solve is Wednesday: Mon/Tue are elapsed + unsolved but BEFORE the first
    // solve, so they are ignored, and the week stays clean.
    const { clean, cells } = weekView([WED], WED);
    expect(clean).toBe(true);
    expect(cells.slice(0, 2).every((c) => !c.solved && !c.isFuture)).toBe(true); // Mon/Tue empty, not missed
  });
});
