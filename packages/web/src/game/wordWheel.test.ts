// CONTRACT (the hole WHEEL, user-decided 2026-09-01): the words found for a tapped hole
// scroll through its slot as one ranked column —
//   - rank DESCENDING top to bottom: farthest at the top, closest at the bottom;
//   - EVERY stop is a row, the words behind the start included (they come first by rank)
//     — reachable and pickable, so none is ever unseen;
//   - the start word IS a row — the player holds it like any other.
// Asserted against the spec, not the implementation.

import { describe, it, expect } from 'vitest';
import type { HistoryStop } from './history';
import { wheelOrder } from './wordWheel';

const stop = (rank: number, behind = false, start = false): HistoryStop => ({
  rank,
  dq: null,
  display: `w${rank}`,
  word: `w${rank}`,
  start,
  best: false,
  behind,
  revealed: false,
});

describe('wheelOrder', () => {
  it('runs farthest → closest top to bottom', () => {
    const rows = wheelOrder([1, 40, 8, 131, 21, 2].map((r) => stop(r, false, r === 131)));
    expect(rows.map((s) => s.rank)).toEqual([131, 40, 21, 8, 2, 1]);
  });

  it('what is behind the start is a row too, first by rank', () => {
    const rows = wheelOrder([stop(300, true), stop(87, false, true), stop(7018, true), stop(3)]);
    expect(rows.map((s) => s.rank)).toEqual([7018, 300, 87, 3]);
  });
});
