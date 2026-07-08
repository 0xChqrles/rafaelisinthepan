// CONTRACT: streak derivation (packages/web/src/game/streak.ts, issue #56). The streak
// counters are DERIVED from the per-language SET of solved game days, never persisted:
//   - currentStreak = the consecutive run ending at the last solved day, but ONLY while
//     the streak is ALIVE (last solve is today or yesterday); a broken chain -> 0;
//   - bestStreak = the longest consecutive run ANYWHERE in the set (all-time best);
//   - both are pure over the day array and defensively sort + dedupe, so deriving from a
//     raw set UNION is order-independent + idempotent (the property the day-set exists
//     for — it makes a future cross-device merge a union + recompute).

import { describe, it, expect } from 'vitest';
import { currentStreak, bestStreak } from './streak';

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
