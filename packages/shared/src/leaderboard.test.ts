import { describe, expect, it } from 'vitest';
import {
  BOARD_TOP_LIMIT,
  boardOwnRows,
  boardWindow,
  cutBoard,
  rankBoard,
  type BoardScore,
} from './leaderboard';

// The #190 board rules, asserted against the issue's spec: competition-style tie
// ranking, the top-50 cut with a straddling tie group collapsed, and the own-row ±2
// neighbor window — the three parts the issue names as contract-tested.

const id = (n: number) => `player${String(n).padStart(11, '0')}`;

const rows = (...scores: number[]): BoardScore[] =>
  scores.map((score, i) => ({ publicId: id(i), score }));

describe('rankBoard', () => {
  it('sorts best-first per mode: sentence ascending, word descending', () => {
    const population = rows(7, 3, 12);
    expect(rankBoard(population, 'sentence').map((r) => r.score)).toEqual([3, 7, 12]);
    expect(rankBoard(population, 'word').map((r) => r.score)).toEqual([12, 7, 3]);
  });

  it('gives tied scores EQUAL ranks, competition style — never a fake ordering', () => {
    // Scores 3, 5, 5, 5, 9 (tries: lower is better): the three 5s all rank 2, and the
    // 9 ranks 5 (everyone strictly ahead, plus one), never 3.
    const ranked = rankBoard(rows(5, 9, 3, 5, 5), 'sentence');
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 2, 2, 5]);
  });

  it('ranks ties identically in word mode (higher is better)', () => {
    const ranked = rankBoard(rows(10, 25, 25, 4), 'word');
    expect(ranked.map((r) => r.score)).toEqual([25, 25, 10, 4]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 1, 3, 4]);
  });

  it('orders inside a tie deterministically (row order, not a ranking claim)', () => {
    const a = rankBoard([{ publicId: 'b'.repeat(16), score: 5 }, { publicId: 'a'.repeat(16), score: 5 }], 'sentence');
    const b = rankBoard([{ publicId: 'a'.repeat(16), score: 5 }, { publicId: 'b'.repeat(16), score: 5 }], 'sentence');
    expect(a).toEqual(b);
  });
});

describe('cutBoard', () => {
  it('returns everyone with no overflow when the board fits', () => {
    const ranked = rankBoard(rows(1, 2, 3), 'sentence');
    expect(cutBoard(ranked)).toEqual({ rows: ranked, overflow: null });
  });

  it('cuts cleanly between two tie groups: no overflow line', () => {
    // 50 distinct scores, then a tie group starting exactly past the boundary.
    const ranked = rankBoard(
      [...Array.from({ length: 50 }, (_, i) => i + 1), 99, 99].map((score, i) => ({
        publicId: id(i),
        score,
      })),
      'sentence',
    );
    const cut = cutBoard(ranked);
    expect(cut.rows).toHaveLength(BOARD_TOP_LIMIT);
    expect(cut.overflow).toBeNull();
  });

  it('collapses a tie group STRADDLING the cut into "+N at rank"', () => {
    // 40 distinct scores, then 30 players tied: showing 10 of the 30 would pretend
    // position 50 means something inside the tie, so the whole group collapses.
    const ranked = rankBoard(
      [
        ...Array.from({ length: 40 }, (_, i) => i + 1),
        ...Array.from({ length: 30 }, () => 77),
      ].map((score, i) => ({ publicId: id(i), score })),
      'sentence',
    );
    const cut = cutBoard(ranked);
    expect(cut.rows).toHaveLength(40);
    expect(cut.rows.at(-1)?.rank).toBe(40);
    expect(cut.overflow).toEqual({ rank: 41, count: 30 });
  });

  it('collapses an all-tied field into one line rather than naming 50 of them', () => {
    const ranked = rankBoard(
      Array.from({ length: 120 }, (_, i) => ({ publicId: id(i), score: 6 })),
      'sentence',
    );
    expect(cutBoard(ranked)).toEqual({ rows: [], overflow: { rank: 1, count: 120 } });
  });

  it('keeps whole groups under a smaller limit too', () => {
    // Groups of 2 (rank 1), 3 (rank 3), 4 (rank 6) under a limit of 4: the pair fits,
    // the trio would cross, so the cut shows 2 rows and collapses the trio.
    const ranked = rankBoard(rows(1, 1, 2, 2, 2, 3, 3, 3, 3), 'sentence');
    expect(cutBoard(ranked, 4)).toEqual({
      rows: ranked.slice(0, 2),
      overflow: { rank: 3, count: 3 },
    });
  });
});

describe('boardWindow / boardOwnRows', () => {
  const ranked = rankBoard(
    Array.from({ length: 100 }, (_, i) => ({ publicId: id(i), score: i + 1 })),
    'sentence',
  );

  it('selects the own row with two neighbors directly above and below', () => {
    const window = boardWindow(ranked, id(69)); // score 70, position 70
    expect(window?.map((r) => r.score)).toEqual([68, 69, 70, 71, 72]);
  });

  it('clamps the window at the board edges', () => {
    expect(boardWindow(ranked, id(0))?.map((r) => r.score)).toEqual([1, 2, 3]);
    expect(boardWindow(ranked, id(99))?.map((r) => r.score)).toEqual([98, 99, 100]);
  });

  it('returns null for a player with no row on the board', () => {
    expect(boardWindow(ranked, 'z'.repeat(16))).toBeNull();
  });

  it('sends no own section when the caller is already visible in the cut', () => {
    const cut = cutBoard(ranked);
    expect(boardOwnRows(ranked, cut, id(10))).toBeNull();
  });

  it('windows a caller below the cut', () => {
    const cut = cutBoard(ranked);
    const own = boardOwnRows(ranked, cut, id(69));
    expect(own?.map((r) => r.score)).toEqual([68, 69, 70, 71, 72]);
  });

  it('never repeats a row the cut already shows when the window brushes the boundary', () => {
    const cut = cutBoard(ranked);
    // Position 52 (score 52): the window reaches back to position 50, already shown.
    const own = boardOwnRows(ranked, cut, id(51));
    expect(own?.map((r) => r.score)).toEqual([51, 52, 53, 54]);
  });

  it('windows a caller hidden inside a collapsed straddling tie', () => {
    const tied = rankBoard(
      [
        ...Array.from({ length: 40 }, (_, i) => i + 1),
        ...Array.from({ length: 30 }, () => 77),
      ].map((score, i) => ({ publicId: id(i), score })),
      'sentence',
    );
    const cut = cutBoard(tied);
    // A member of the collapsed group is not individually visible, so it gets a window.
    const own = boardOwnRows(tied, cut, id(55));
    expect(own).not.toBeNull();
    expect(own?.some((r) => r.publicId === id(55))).toBe(true);
  });
});
