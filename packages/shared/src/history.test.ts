// CONTRACT (#211/#204): what a solved-day COLLECTION says about an account. Both readings
// are cross-package — the web draws them on the account screen, the backend names them in
// the erase confirmation — so a second spelling on either side would put different numbers
// on the same days.

import { describe, it, expect } from 'vitest';
import { bestStreak, boundSolvedDays, currentStreak, MAX_SOLVED_DAYS } from './history';

describe('currentStreak', () => {
  it('counts the run ending at the last solve, while the chain is still ALIVE', () => {
    // Today counts, and so does yesterday: a chain is not broken until the day after.
    expect(currentStreak([10, 11, 12], 12)).toBe(3);
    expect(currentStreak([10, 11, 12], 13)).toBe(3);
    // Older than yesterday and the chain is gone, however long it was.
    expect(currentStreak([10, 11, 12], 14)).toBe(0);
    expect(currentStreak([], 14)).toBe(0);
  });

  it('counts only the tail run, not an earlier equal-or-longer one', () => {
    // Earlier run [1,2,3] is broken; the live run is [9,10].
    expect(currentStreak([1, 2, 3, 9, 10], 10)).toBe(2);
  });

  it('a single solved day today is a streak of 1', () => {
    expect(currentStreak([10], 10)).toBe(1);
  });

  it('is order-independent and idempotent — the collection is a merged SET', () => {
    expect(currentStreak([12, 10, 11, 11], 12)).toBe(3);
  });
});

describe('currentStreak over a UNION — the reason the collection is a set of days', () => {
  // A union of two devices' solved-day sets derives the same whatever the order and however
  // often a set is included: that is exactly why the streak stores the SET, not a counter
  // (a counter can't merge).
  const A = [1, 2, 3, 10];
  const B = [3, 4, 11, 12]; // overlaps A on day 3, out of order

  it('is order-independent: A∪B derives the same as B∪A', () => {
    expect(currentStreak([...A, ...B], 12)).toBe(currentStreak([...B, ...A], 12));
  });

  it('is idempotent: re-including an already-present set changes nothing', () => {
    const union = [...A, ...B];
    expect(currentStreak([...union, ...A], 12)).toBe(currentStreak(union, 12));
  });

  it('derives the streak of the deduped union', () => {
    // union sorted+deduped = [1,2,3,4,10,11,12]; current (activeDay 12) = [10,11,12] = 3.
    expect(currentStreak([...A, ...B], 12)).toBe(3);
  });
});

describe('bestStreak', () => {
  it('is the longest run the collection has ever held, alive or broken', () => {
    // The record survives the break that ended it: nothing about today can lower it.
    expect(bestStreak([1, 2, 3, 4, 7, 8])).toBe(4);
    expect(bestStreak([1, 2, 3, 4, 7, 8, 9, 10, 11])).toBe(5);
    expect(bestStreak([5])).toBe(1);
    expect(bestStreak([])).toBe(0);
  });

  it('takes no active day — a record is a fact about days already played', () => {
    // The same collection reads the same however long ago it was played, where
    // `currentStreak` would have gone to zero.
    expect(bestStreak([10, 11, 12])).toBe(3);
    expect(currentStreak([10, 11, 12], 900)).toBe(0);
  });

  it('is order-independent and idempotent, like the streak beside it', () => {
    expect(bestStreak([3, 1, 2, 2, 8])).toBe(3);
  });

  it('never exceeds the collection the store is allowed to keep', () => {
    const every = Array.from({ length: MAX_SOLVED_DAYS + 50 }, (_, i) => i + 1);
    expect(bestStreak(boundSolvedDays(every))).toBe(MAX_SOLVED_DAYS);
  });
});
