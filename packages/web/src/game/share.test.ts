// CONTRACT: the solved-screen share (issue #8, packages/web/src/game/share.ts), asserted
// against the agreed design:
//   - the per-guess progress trajectory is replayed from the ordered guesses;
//   - it is collapsed into a BOUNDED number of squares (3..18) on a hardcoded breakpoint
//     curve (more tries -> more squares), each square = the MEAN progress of its bucket;
//   - the result is shared as a link `<origin>/s/<token>` that the backend unfurls into the
//     card image (the codec itself is contract-tested in @whippin/shared).

import { describe, it, expect } from 'vitest';
import {
  progressTrajectory,
  squareCount,
  bucketMeans,
  shareUrl,
  SQUARE_BREAKPOINTS,
  MIN_SQUARES,
  MAX_SQUARES,
} from './share';
import { computeProgress } from './scoring';
import { decodeResult, type RankMap, type RuntimeHole } from '@whippin/shared';

// A rank map for one secret with N entries -> N keys, `wI` at rank I (so `w0` == solved).
function mk(N: number): RankMap[string] {
  const inner: RankMap[string] = {};
  for (let i = 0; i < N; i++) inner[`w${i}`] = { word: `w${i}`, rank: i };
  return inner;
}
function hole(secret: string, startRank: number): RuntimeHole {
  return { pos: 0, secret, word: secret, rank: startRank, startRank };
}

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

describe('shareUrl — result packed into a /s/<token> link', () => {
  // A real dayNumber (days since 1970 ≈ 20638 today) and a 3-try perfect game (3 squares).
  const result = { lang: 'fr', dayNumber: 20638, score: 3, squares: [40, 70, 100] };

  it('builds <origin>/s/<token> and the token round-trips the result', () => {
    const url = shareUrl('https://whippin.ai', result);
    expect(url.startsWith('https://whippin.ai/s/')).toBe(true);
    const decoded = decodeResult(url.slice('https://whippin.ai/s/'.length));
    expect(decoded?.lang).toBe('fr');
    expect(decoded?.dayNumber).toBe(20638);
    expect(decoded?.score).toBe(3);
    expect(decoded?.squares).toHaveLength(3);
  });

  it('carries no spoilers — the sentence/words never appear in the link', () => {
    const url = shareUrl('https://whippin.ai', result);
    // Only the origin, the /s/ path, and a base64url token.
    expect(url).toMatch(/^https:\/\/whippin\.ai\/s\/[A-Za-z0-9_-]+$/);
  });
});
