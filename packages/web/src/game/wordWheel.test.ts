// CONTRACT (the hole WHEEL, user-decided 2026-09-01): the words found for a tapped hole
// scroll through its slot as one ranked column —
//   - rank DESCENDING top to bottom: farthest at the top, closest at the bottom;
//   - EVERY stop is a row, the words behind the start included (they come first by rank)
//     — reachable and pickable, so none is ever unseen;
//   - the start word IS a row — the player holds it like any other.
// Asserted against the spec, not the implementation.

import { describe, it, expect } from 'vitest';
import type { HistoryStop } from './history';
import type { RankMap, RuntimeHole } from '@whippin/shared';
import { replayCharge } from './charge';
import { latestMaskedPick, retireDisplacedPicks, selectWord, wheelOrder } from './wordWheel';

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
    expect(retireDisplacedPicks(picks, consumed)).toBe(picks); // a taken hint keeps its chosen word
    for (const rank of [0, 9]) {
      expect(latestMaskedPick(picks, holes.map((h) => ({ ...h, rank })), charges)).toBeNull();
    }
    const replaced = selectWord(selectWord(picks, 0, stop(10), 10), 2, stop(10), 10);
    expect(latestMaskedPick(replaced, holes, charges)).toBeNull();
  });

  it('retires a mask pushed out by worse guesses without moving the best word', () => {
    const inner = Object.fromEntries(Array.from({ length: 70 }, (_, i) => {
      const rank = i + 1;
      return [`w${rank}`, { word: `w${rank}`, rank }];
    }));
    const ranks: RankMap = { secret: { ...inner, secret: { word: 'secret', rank: 0 } } };
    const fresh: RuntimeHole[] = [{ pos: 0, secret: 'secret', word: 'w50', rank: 50, startRank: 50 }];
    const base = [4, 6, 30, 31, 32, 33].map((rank) => `w${rank}`);
    const active = replayCharge(fresh, ranks, base)[0];
    const picks = selectWord({}, 0, mask(51), 4);
    expect(active.given.some((g) => g.rank === 51)).toBe(true);
    expect(retireDisplacedPicks(picks, [active])).toBe(picks);

    // Both new guesses are worse than rank 4, but their openings displace rank 51.
    const pushed = replayCharge(fresh, ranks, [...base, 'w12', 'w20'])[0];
    expect(pushed.given.map((g) => g.rank)).toEqual([5, 7, 13, 21, 34]);
    const live = [{ ...fresh[0], rank: 4 }];
    expect(latestMaskedPick(picks, live, [pushed])).toBeNull();
    const retired = retireDisplacedPicks(picks, [pushed]);
    expect(retired).toEqual({});
    // Even if rank 51 becomes available again, the old selection cannot reappear.
    expect(latestMaskedPick(retired, live, [active])).toBeNull();
  });
});
