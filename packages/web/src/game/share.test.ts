// CONTRACT: the solved-screen share (issue #8, packages/web/src/game/share.ts), asserted
// against the agreed design:
//   - the per-guess progress trajectory is replayed from the ordered guesses;
//   - it is collapsed into a BOUNDED number of squares (3..18) on a hardcoded breakpoint
//     curve (more tries -> more squares), each square = the MEAN progress of its bucket;
//   - each square's emoji uses the 33/67/100 bucket mapping; the share text is ONE row of
//     those emoji (spoiler-free: emoji only, never the words).

import { describe, it, expect } from 'vitest';
import {
  progressTrajectory,
  squareCount,
  bucketMeans,
  shareEmoji,
  buildShareText,
  SQUARE_BREAKPOINTS,
  MIN_SQUARES,
  MAX_SQUARES,
} from './share';
import { computeProgress } from './scoring';
import type { RankMap, RuntimeHole } from '@whippin/shared';

// A rank map for one secret with N entries -> N keys, `wI` at rank I (so `w0` == solved).
function mk(N: number): RankMap[string] {
  const inner: RankMap[string] = {};
  for (let i = 0; i < N; i++) inner[`w${i}`] = { word: `w${i}`, rank: i };
  return inner;
}
function hole(secret: string, startRank: number): RuntimeHole {
  return { pos: 0, secret, word: secret, rank: startRank, startRank };
}

describe('shareEmoji — 33 / 67 / 100 heat buckets (pct <= max)', () => {
  it('cold (🟥) at and below 33', () => {
    for (const p of [0, 1, 20, 33]) expect(shareEmoji(p)).toBe('🟥');
  });
  it('warm (🟪) above 33 up to 67', () => {
    for (const p of [33.5, 34, 50, 67]) expect(shareEmoji(p)).toBe('🟪');
  });
  it('hot (🟦) above 67 up to 100', () => {
    for (const p of [67.5, 68, 90, 100]) expect(shareEmoji(p)).toBe('🟦');
  });
});

describe('squareCount — hardcoded breakpoint curve, 3..18', () => {
  it('is the minimum 3 for a perfect game (3 holes -> 3 distinct words)', () => {
    expect(squareCount(3)).toBe(3);
    expect(MIN_SQUARES).toBe(3);
  });

  it('adds one square at each breakpoint (half-open, tries >= t)', () => {
    // Spot-check the agreed ranges.
    expect(squareCount(4)).toBe(4);
    expect(squareCount(5)).toBe(4);
    expect(squareCount(6)).toBe(5);
    expect(squareCount(9)).toBe(5);
    expect(squareCount(10)).toBe(6);
    expect(squareCount(99)).toBe(11);
    expect(squareCount(100)).toBe(12);
    expect(squareCount(119)).toBe(12);
    expect(squareCount(120)).toBe(13);
    expect(squareCount(299)).toBe(17);
    expect(squareCount(300)).toBe(18);
  });

  it('caps at MAX_SQUARES (18) no matter how many tries', () => {
    expect(MAX_SQUARES).toBe(18);
    expect(squareCount(300)).toBe(MAX_SQUARES);
    expect(squareCount(5000)).toBe(MAX_SQUARES);
    expect(MAX_SQUARES).toBe(MIN_SQUARES + SQUARE_BREAKPOINTS.length);
  });

  it('is monotonic non-decreasing in tries', () => {
    for (let t = 3; t < 400; t++) expect(squareCount(t + 1)).toBeGreaterThanOrEqual(squareCount(t));
  });
});

describe('bucketMeans — collapse the trajectory into squareCount buckets', () => {
  it('returns squareCount(n) values, each the mean of a contiguous bucket', () => {
    const traj = Array.from({ length: 20 }, (_, i) => (100 * (i + 1)) / 20); // 5,10,...,100
    const squares = bucketMeans(traj);
    expect(squares).toHaveLength(squareCount(20)); // 7
    // Buckets are contiguous + as-equal-as-possible; overall mean is preserved-ish and
    // every value stays within the data range.
    for (const v of squares) {
      expect(v).toBeGreaterThanOrEqual(traj[0]);
      expect(v).toBeLessThanOrEqual(traj[traj.length - 1]);
    }
  });

  it('is monotonic non-decreasing (progress is, and buckets are contiguous)', () => {
    const traj = Array.from({ length: 137 }, (_, i) => (100 * (i + 1)) / 137);
    const squares = bucketMeans(traj);
    expect(squares).toHaveLength(squareCount(137)); // 13
    for (let i = 1; i < squares.length; i++) expect(squares[i]).toBeGreaterThanOrEqual(squares[i - 1]);
  });

  it('at the minimum (3 guesses) each square IS that guess (m == n)', () => {
    const traj = [40, 75, 100];
    expect(bucketMeans(traj)).toEqual([40, 75, 100]);
  });

  it('averages within a bucket (not just samples)', () => {
    // 6 guesses -> 5 squares: with floor(i*n/m) boundaries the LAST bucket holds two
    // points [50,60] and shows their mean (55); the rest are singletons.
    const traj = [10, 20, 30, 40, 50, 60];
    expect(bucketMeans(traj)).toEqual([10, 20, 30, 40, 55]);
  });

  it('handles no guesses without throwing', () => {
    expect(bucketMeans([])).toEqual([]);
  });
});

describe('progressTrajectory — replay the ordered guesses', () => {
  const ranks: RankMap = { a: mk(1000) };
  const fresh: RuntimeHole[] = [hole('a', 300)];

  it('has one value per counted guess, monotonic, ending at 100 when solved', () => {
    const t = progressTrajectory(fresh, ranks, ['w200', 'w50', 'w0']);
    expect(t).toHaveLength(3);
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThanOrEqual(t[i - 1]);
    expect(t[t.length - 1]).toBeCloseTo(100, 9);
  });

  it('each value equals computeProgress at that hole rank (matches the live loop)', () => {
    const t = progressTrajectory(fresh, ranks, ['w200', 'w50', 'w0']);
    expect(t[0]).toBeCloseTo(computeProgress([{ ...fresh[0], rank: 200 }], ranks), 9);
    expect(t[1]).toBeCloseTo(computeProgress([{ ...fresh[0], rank: 50 }], ranks), 9);
  });

  it('a guess worse than the current rank does not regress a hole', () => {
    const t = progressTrajectory(fresh, ranks, ['w50', 'w200']);
    expect(t[1]).toBe(t[0]);
  });

  it('a guess absent from a hole map (a MISS for it) leaves that hole untouched', () => {
    const t = progressTrajectory(fresh, ranks, ['zzz']);
    expect(t[0]).toBe(0);
  });

  it('advances several holes at once, averaging their progress', () => {
    const two: RankMap = { a: mk(1000), b: mk(1000) };
    const holes: RuntimeHole[] = [hole('a', 300), hole('b', 300)];
    const t = progressTrajectory(holes, two, ['w0']);
    expect(t[0]).toBeCloseTo(100, 9);
  });
});

describe('buildShareText — spoiler-free single emoji row', () => {
  const squares = [12, 45, 100]; // per-square mean progress %

  it('header carries the day number and score; the grid is ONE row, one emoji per square', () => {
    const text = buildShareText({ dayNumber: 7, guessCount: 3, squares });
    const lines = text.split('\n').filter(Boolean);
    expect(lines[0]).toBe('Whippin AI #7 — SCORE 3');
    expect(lines[1]).toBe('🟥🟪🟦'); // single line, one emoji per square, no % and no newlines
    expect(lines).toHaveLength(2);
  });

  it('omits the day number for an override (no day)', () => {
    const text = buildShareText({ dayNumber: null, guessCount: 3, squares });
    expect(text.split('\n')[0]).toBe('Whippin AI — SCORE 3');
  });

  it('appends the url when given, and never leaks a word (no letters in the grid)', () => {
    const text = buildShareText({ dayNumber: 7, guessCount: 3, squares, url: 'https://whippin.ai' });
    expect(text.endsWith('https://whippin.ai')).toBe(true);
    const grid = text.split('\n\n')[1];
    expect(grid).not.toMatch(/[a-z0-9]/i); // emoji only, no spoilers, no digits
  });
});
