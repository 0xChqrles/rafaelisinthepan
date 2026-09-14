import { describe, expect, it } from 'vitest';
import {
  BOARD_TOP_LIMIT,
  boardOwnRows,
  boardWindow,
  cutBoard,
  orderPlaying,
  rankBoard,
  rankPeriod,
  standingIn,
  type BoardScore,
  type PeriodDay,
  type PlayingScore,
} from './leaderboard';

// The #190 board rules, asserted against the decided spec: competition-style tie
// ranking, the plain top-50 cut (nothing folded — user-decided 2026-08-20, superseding
// the issue's straddling-tie collapse), and the own-row ±2 neighbor window.

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
  it('returns everyone when the board fits', () => {
    const ranked = rankBoard(rows(1, 2, 3), 'sentence');
    expect(cutBoard(ranked)).toEqual(ranked);
  });

  it('shows at most 50 rows — nothing folded (user-decided 2026-08-20)', () => {
    const ranked = rankBoard(
      Array.from({ length: 80 }, (_, i) => ({ publicId: id(i), score: i + 1 })),
      'sentence',
    );
    const cut = cutBoard(ranked);
    expect(cut).toHaveLength(BOARD_TOP_LIMIT);
    expect(cut).toEqual(ranked.slice(0, BOARD_TOP_LIMIT));
  });

  it('cuts straight through a tie: members inside the boundary show at the shared rank', () => {
    // 40 distinct scores, then 30 players tied at rank 41: the cut shows the first 10
    // of them as ordinary rows, all ranked 41.
    const ranked = rankBoard(
      [
        ...Array.from({ length: 40 }, (_, i) => i + 1),
        ...Array.from({ length: 30 }, () => 77),
      ].map((score, i) => ({ publicId: id(i), score })),
      'sentence',
    );
    const cut = cutBoard(ranked);
    expect(cut).toHaveLength(BOARD_TOP_LIMIT);
    expect(cut.slice(40).every((row) => row.rank === 41 && row.score === 77)).toBe(true);
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

  it('windows a tie member whose row fell past the boundary', () => {
    const tied = rankBoard(
      [
        ...Array.from({ length: 40 }, (_, i) => i + 1),
        ...Array.from({ length: 30 }, () => 77),
      ].map((score, i) => ({ publicId: id(i), score })),
      'sentence',
    );
    const cut = cutBoard(tied);
    // Positions 41-50 of the tie are shown; a member past the cut still gets a window,
    // and a member inside it does not.
    const inside = cut.at(-1)!.publicId;
    expect(boardOwnRows(tied, cut, inside)).toBeNull();
    const outside = tied[55].publicId;
    const own = boardOwnRows(tied, cut, outside);
    expect(own).not.toBeNull();
    expect(own?.some((r) => r.publicId === outside)).toBe(true);
  });
});

// The #206 in-progress rows' order: closest to done first, fewer tries breaking the
// tie, publicId last — an ORDER, never a rank claim (the rows carry no rank number).
describe('orderPlaying (#206)', () => {
  const playing = (publicId: string, progress: number, tries: number): PlayingScore => ({
    publicId,
    tries,
    progress,
  });

  it('orders by progress down, then tries up, then publicId', () => {
    const shuffled = [
      playing('cccccccccccccccc', 40, 1),
      playing('bbbbbbbbbbbbbbbb', 80, 5),
      playing('dddddddddddddddd', 80, 3),
      playing('aaaaaaaaaaaaaaaa', 80, 5),
    ];
    expect(orderPlaying(shuffled).map((row) => row.publicId)).toEqual([
      'dddddddddddddddd', // furthest along with the fewest tries
      'aaaaaaaaaaaaaaaa', // tied with b on both numbers: id decides, deterministically
      'bbbbbbbbbbbbbbbb',
      'cccccccccccccccc',
    ]);
  });

  it('is a pure reordering: the input array is left alone', () => {
    const input = [playing('bbbbbbbbbbbbbbbb', 10, 1), playing('aaaaaaaaaaaaaaaa', 90, 1)];
    const before = [...input];
    orderPlaying(input);
    expect(input).toEqual(before);
  });

  it('progress dominates tries: a 90% row with many tries leads a 10% row with one', () => {
    const ordered = orderPlaying([
      playing('aaaaaaaaaaaaaaaa', 10, 1),
      playing('bbbbbbbbbbbbbbbb', 90, 400),
    ]);
    expect(ordered.map((row) => row.publicId)).toEqual([
      'bbbbbbbbbbbbbbbb',
      'aaaaaaaaaaaaaaaa',
    ]);
  });
});

// The #271 PERIOD rule: podium points per day (3/2/1 by competition rank), then solved
// days, then the total in the mode's direction, publicId last; equal lines share a rank.
describe('rankPeriod (#271)', () => {
  const day = (publicId: string, date: string, score: number): PeriodDay => ({ publicId, date, score });
  const A = 'aaaaaaaaaaaaaaaa';
  const B = 'bbbbbbbbbbbbbbbb';
  const C = 'cccccccccccccccc';
  const D = 'dddddddddddddddd';

  it('pays podium points per day and ranks by them first', () => {
    const ranked = rankPeriod(
      [
        // Day 1: A first (3), B second (2), C third (1).
        day(A, '2026-09-07', 3), day(B, '2026-09-07', 5), day(C, '2026-09-07', 9),
        // Day 2: C first (3), A second (2); B absent.
        day(C, '2026-09-08', 4), day(A, '2026-09-08', 6),
      ],
      'sentence',
    );
    expect(ranked.map((row) => [row.publicId, row.rank, row.points, row.solvedDays, row.total])).toEqual([
      [A, 1, 5, 2, 9],
      [C, 2, 4, 2, 13],
      [B, 3, 2, 1, 5],
    ]);
  });

  it('pays a shared first place to both, and the next rank is then third', () => {
    const ranked = rankPeriod(
      [day(A, '2026-09-07', 4), day(B, '2026-09-07', 4), day(C, '2026-09-07', 7)],
      'sentence',
    );
    expect(ranked.map((row) => [row.publicId, row.points])).toEqual([[A, 3], [B, 3], [C, 1]]);
    // Equal on every number: a shared rank, never a fake ordering.
    expect(ranked.map((row) => row.rank)).toEqual([1, 1, 3]);
  });

  it('breaks equal points by solved days, then by fewer tries', () => {
    const ranked = rankPeriod(
      [
        // Day 1: B first (3), C second (2), A third (1).
        day(B, '2026-09-07', 2), day(C, '2026-09-07', 5), day(A, '2026-09-07', 9),
        // Day 2: D first (3), A second (2).
        day(D, '2026-09-08', 8), day(A, '2026-09-08', 9),
      ],
      'sentence',
    );
    // A, B and D all hold 3 points: A played two days and leads them; B and D played one
    // each, and B's 2 tries beat D's 8. C's 2 points come last.
    expect(ranked.map((row) => [row.publicId, row.rank, row.points, row.solvedDays, row.total])).toEqual([
      [A, 1, 3, 2, 18],
      [B, 2, 3, 1, 2],
      [D, 3, 3, 1, 8],
      [C, 4, 2, 1, 5],
    ]);
  });

  it('reads the total in Word mode the other way: more words is better', () => {
    const ranked = rankPeriod(
      [day(A, '2026-09-07', 10), day(B, '2026-09-08', 30)],
      'word',
    );
    // Each is first on their own day: equal points and days, so the total decides.
    expect(ranked.map((row) => row.publicId)).toEqual([B, A]);
  });

  it('is empty for an empty range and pure for its input', () => {
    expect(rankPeriod([], 'sentence')).toEqual([]);
    const input = [day(A, '2026-09-07', 1)];
    const before = [...input];
    rankPeriod(input, 'sentence');
    expect(input).toEqual(before);
  });
});

// The #271 standing line reads the caller's DAY rank off the same competition ranking the
// board draws, out of the members who recorded a score today.
describe('standingIn (#271)', () => {
  it('is the caller rank out of the ranked rows, ties shared', () => {
    const ranked = rankBoard(rows(5, 3, 5, 9), 'sentence');
    expect(standingIn(ranked, id(1))).toEqual({ rank: 1, of: 4 });
    // The two 5s share second place, competition style.
    expect(standingIn(ranked, id(0))).toEqual({ rank: 2, of: 4 });
    expect(standingIn(ranked, id(2))).toEqual({ rank: 2, of: 4 });
    expect(standingIn(ranked, id(3))).toEqual({ rank: 4, of: 4 });
  });

  it('is null for a caller with no recorded score on the board', () => {
    expect(standingIn(rankBoard(rows(4), 'sentence'), 'z'.repeat(16))).toBeNull();
    expect(standingIn([], id(0))).toBeNull();
  });
});
