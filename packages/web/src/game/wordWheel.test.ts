// CONTRACT (the hole WHEEL, user-decided 2026-09-01): the words found for a tapped hole
// scroll through its slot as one ranked column —
//   - rank DESCENDING top to bottom: farthest at the top, closest at the bottom;
//   - EVERY stop is a row, the words behind the start included (they come first by rank)
//     — reachable and pickable, so none is ever unseen;
//   - the start word IS a row — the player holds it like any other.
// Asserted against the spec, not the implementation.

import { describe, it, expect } from 'vitest';
import type { HistoryStop } from './history';
import type { RuntimeHole } from '@whippin/shared';
import { latestMaskedPick, selectWord, wheelOrder } from './wordWheel';

const stop = (rank: number, behind = false, start = false): HistoryStop => ({
  rank,
  dq: null,
  display: `w${rank}`,
  word: `w${rank}`,
  slug: `w${rank}`,
  start,
  best: false,
  behind,
  revealed: false,
  given: false,
  masked: false,
  taken: false,
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

describe('the selected hint', () => {
  const holes: RuntimeHole[] = [0, 1, 2].map((pos) => ({
    pos, secret: `secret${pos}`, word: 'best', rank: 10, startRank: 50,
  }));
  const charges = holes.map(() => ({ charge: 100, active: true, given: [
    { rank: 11, consumed: false }, { rank: 12, consumed: false },
  ] }));
  const mask = (rank: number): HistoryStop => ({ ...stop(rank), masked: true, given: true, display: '?????', word: '' });

  it('reveals the latest selection even when it is earlier in the sentence', () => {
    let picks = selectWord({}, 2, mask(11), 10);
    picks = selectWord(picks, 0, mask(12), 10);
    expect(latestMaskedPick(picks, holes, charges)).toEqual({ index: 0, slug: 'w12' });
    picks = selectWord(picks, 2, mask(12), 10);
    expect(latestMaskedPick(picks, holes, charges)).toEqual({ index: 2, slug: 'w12' });
  });

  it('retires consumed, solved, improved and replaced selections', () => {
    const picks = selectWord(selectWord({}, 2, mask(11), 10), 0, mask(12), 10);
    const consumed = charges.map((c, i) => i === 0 ? { ...c, given: [{ rank: 12, consumed: true }] } : c);
    expect(latestMaskedPick(picks, holes, consumed)).toEqual({ index: 2, slug: 'w11' });
    for (const rank of [0, 9]) {
      expect(latestMaskedPick(picks, holes.map((h) => ({ ...h, rank })), charges)).toBeNull();
    }
    const replaced = selectWord(selectWord(picks, 0, stop(10), 10), 2, stop(10), 10);
    expect(latestMaskedPick(replaced, holes, charges)).toBeNull();
  });
});
