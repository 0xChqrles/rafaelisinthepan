// CONTRACT (the hole WHEEL, user-decided 2026-09-01): the words found for a tapped hole
// scroll through its slot as one ranked column —
//   - rank DESCENDING top to bottom: farthest at the top, closest at the bottom;
//   - EVERY stop is a row, the words behind the start included (they come first by rank)
//     — reachable and pickable, so none is ever unseen;
//   - the start word IS a row — the player holds it like any other;
//   - the word in the slot when the wheel folds is the PICK, display only: the hole shows
//     it until it next improves; a picked MASK — the one word offered closer than the best
//     (#301) — shows `?????` at its rank until the reveal lands, when the hole improves to
//     the word and shows it as its own; BACK undoes every masked pick.
// Asserted against the spec, not the implementation.

import { describe, it, expect } from 'vitest';
import { MASK, type HistoryStop } from './history';
import type { RankMap } from '@whippin/shared';
import type { RuntimeHole } from './types';
import { replayCharge } from './charge';
import { latestMaskedPick, selectWord, shownHolesFor, wheelOrder, withoutMaskedPicks } from './wordWheel';

const stop = (rank: number, behind = false, start = false): HistoryStop => ({
  rank,
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

describe('the selected hint — the ghost a REVEAL submits', () => {
  // Every hole stands at 10 and offers 9, the word just closer.
  const holes: RuntimeHole[] = [0, 1, 2].map((pos) => ({
    pos, secret: `secret${pos}`, word: 'best', rank: 10, startRank: 50,
  }));
  const charges = holes.map(() => ({ charge: 100, active: true, given: [{ rank: 9, consumed: false }] }));
  const mask = (rank: number): HistoryStop => ({ ...stop(rank), masked: true, given: true, display: '?????', word: '' });

  it('is the latest masked selection, even when it is earlier in the sentence', () => {
    let picks = selectWord({}, 2, mask(9), 10);
    picks = selectWord(picks, 0, mask(9), 10);
    expect(latestMaskedPick(picks, holes, charges)).toEqual({ index: 0, slug: 'w9' });
    picks = selectWord(picks, 2, mask(9), 10);
    expect(latestMaskedPick(picks, holes, charges)).toEqual({ index: 2, slug: 'w9' });
  });

  it('a consumed, solved, improved or replaced selection is no ghost', () => {
    const picks = selectWord(selectWord({}, 2, mask(9), 10), 0, mask(9), 10);
    // Hole 0's offer taken: the older pick on hole 2 is the ghost again.
    const consumed = charges.map((c, i) => (i === 0 ? { ...c, given: [{ rank: 9, consumed: true }] } : c));
    expect(latestMaskedPick(picks, holes, consumed)).toEqual({ index: 2, slug: 'w9' });
    // Solved, or improved past the rank it was picked against.
    for (const rank of [0, 9, 4]) {
      expect(latestMaskedPick(picks, holes.map((h) => ({ ...h, rank })), charges)).toBeNull();
    }
    const replaced = selectWord(selectWord(picks, 0, stop(10), 10), 2, stop(10), 10);
    expect(latestMaskedPick(replaced, holes, charges)).toBeNull();
  });

  it('a closer word typed by hand moves the offer under it: the old pick is spent', () => {
    const inner = Object.fromEntries(Array.from({ length: 70 }, (_, i) => {
      const rank = i + 1;
      return [`w${rank}`, { word: `w${rank}`, rank }];
    }));
    const ranks: RankMap = { secret: { ...inner, secret: { word: 'secret', rank: 0 } } };
    const fresh: RuntimeHole[] = [{ pos: 0, secret: 'secret', word: 'w50', rank: 50, startRank: 50 }];
    // 4, 6, 30 … 33 fill the meter: the best is 4, the offer 3.
    const base = [4, 6, 30, 31, 32, 33].map((rank) => `w${rank}`);
    const active = replayCharge(fresh, ranks, base)[0];
    const picks = selectWord({}, 0, mask(3), 4);
    const at4 = [{ ...fresh[0], rank: 4 }];
    expect(latestMaskedPick(picks, at4, [active])).toEqual({ index: 0, slug: 'w3' });
    // The full log already holds w2 (the board still shows 4, its swap in the air): the
    // offer is 1 now, so the pick of 3 is no ghost.
    const moved = replayCharge(fresh, ranks, [...base, 'w2'])[0];
    expect(moved.given).toEqual([{ rank: 1, consumed: false }]);
    expect(latestMaskedPick(picks, at4, [moved])).toBeNull();
  });

  it('BACK undoes every masked pick and keeps the picks of held words', () => {
    const picks = selectWord(selectWord(selectWord({}, 0, mask(9), 10), 1, stop(40), 10), 2, mask(9), 10);
    const back = withoutMaskedPicks(picks);
    expect(Object.keys(back)).toEqual(['1']);
    expect(back[1]).toBe(picks[1]);
    expect(latestMaskedPick(back, holes, charges)).toBeNull();
  });
});

describe('shownHolesFor — a pick stands in its hole, display only', () => {
  const board: RuntimeHole[] = [
    { pos: 0, secret: 'a', word: 'best', rank: 10, startRank: 50 },
    { pos: 1, secret: 'b', word: 'other', rank: 20, startRank: 50 },
  ];
  // The first hole is active and offers rank 9; the second gives nothing.
  const meters = [
    { charge: 100, active: true, given: [{ rank: 9, consumed: false }] },
    { charge: 0, active: false, given: [] },
  ];
  const hint: HistoryStop = { ...stop(9), masked: true, given: true, display: MASK, word: '', slug: 'foret' };

  it('a picked earlier word stands in the hole with its rank; the other holes are untouched', () => {
    const shown = shownHolesFor(board, selectWord({}, 0, stop(40), 10), meters);
    expect(shown[0]).toEqual({ ...board[0], word: 'w40', rank: 40 });
    expect(shown[1]).toBe(board[1]);
  });

  it('the pick lasts until the hole improves, and a found hole shows its own word', () => {
    const picks = selectWord({}, 0, stop(40), 10);
    for (const rank of [9, 0]) {
      const moved = [{ ...board[0], rank }, board[1]];
      expect(shownHolesFor(moved, picks, meters)[0]).toBe(moved[0]);
    }
  });

  it("a pick of the hole's own word is simply the hole", () => {
    expect(shownHolesFor(board, selectWord({}, 0, stop(10), 10), meters)[0]).toBe(board[0]);
  });

  it('a picked MASK shows the mask at its rank; once revealed the hole improves to the word and is itself', () => {
    const picks = selectWord({}, 0, hint, 10);
    expect(shownHolesFor(board, picks, meters)[0]).toEqual({ ...board[0], word: MASK, rank: 9 });
    const revealed = [{ ...board[0], word: 'forêt', rank: 9 }, board[1]];
    const after = [{ charge: 100, active: true, given: [{ rank: 8, consumed: false }, { rank: 9, consumed: true }] }, meters[1]];
    expect(shownHolesFor(revealed, picks, after)[0]).toBe(revealed[0]);
  });

  it('a masked pick the meters no longer offer — or a board showing no meters — is the hole itself', () => {
    const picks = selectWord({}, 0, hint, 10);
    const moved = [{ charge: 100, active: true, given: [{ rank: 7, consumed: false }] }, meters[1]];
    expect(shownHolesFor(board, picks, moved)[0]).toBe(board[0]);
    expect(shownHolesFor(board, picks, undefined)[0]).toBe(board[0]);
    // A pick of a word the player already holds needs no meter.
    expect(shownHolesFor(board, selectWord({}, 0, stop(40), 10), undefined)[0]).toEqual({
      ...board[0],
      word: 'w40',
      rank: 40,
    });
  });
});
