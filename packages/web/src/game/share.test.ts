// CONTRACT: the solved-screen share text (issue #8, packages/web/src/game/share.ts),
// asserted against the acceptance criteria:
//   - the grid has ONE line per counted guess (== score == tries), spoiler-free;
//   - each line's reconstruction % comes from computeProgress (game/scoring.ts) replayed
//     over the ordered guesses, and its emoji uses the 33/67/100 bucket mapping;
//   - the trajectory is monotonic non-decreasing and ends at 100 when solved.

import { describe, it, expect } from 'vitest';
import { progressTrajectory, shareEmoji, buildShareText } from './share';
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

describe('progressTrajectory — replay the ordered guesses', () => {
  // One hole, secret `a` starting at rank 300. Guesses walk it closer: 300 -> 50 -> 0.
  const ranks: RankMap = { a: mk(1000) };
  const fresh: RuntimeHole[] = [hole('a', 300)];

  it('has one value per counted guess', () => {
    const t = progressTrajectory(fresh, ranks, ['w200', 'w50', 'w0']);
    expect(t).toHaveLength(3);
  });

  it('is monotonic non-decreasing and ends at 100 when solved', () => {
    const t = progressTrajectory(fresh, ranks, ['w200', 'w50', 'w0']);
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThanOrEqual(t[i - 1]);
    expect(t[t.length - 1]).toBeCloseTo(100, 9);
  });

  it('each value equals computeProgress at that hole rank (matches the live loop)', () => {
    const t = progressTrajectory(fresh, ranks, ['w200', 'w50', 'w0']);
    expect(t[0]).toBeCloseTo(computeProgress([{ ...fresh[0], rank: 200 }], ranks), 9);
    expect(t[1]).toBeCloseTo(computeProgress([{ ...fresh[0], rank: 50 }], ranks), 9);
    expect(t[2]).toBeCloseTo(100, 9);
  });

  it('a guess that is worse than the current rank does not regress a hole', () => {
    // First get to rank 50, then a farther word (rank 200) must NOT push the hole back.
    const t = progressTrajectory(fresh, ranks, ['w50', 'w200']);
    expect(t[1]).toBe(t[0]);
  });

  it('a guess absent from a hole map (a MISS for it) leaves that hole untouched', () => {
    const t = progressTrajectory(fresh, ranks, ['zzz']); // not a key in ranks.a
    expect(t[0]).toBe(0); // still at start rank -> 0% progress
  });

  it('advances several holes at once, averaging their progress', () => {
    const two: RankMap = { a: mk(1000), b: mk(1000) };
    const holes: RuntimeHole[] = [hole('a', 300), hole('b', 300)];
    // `w0` is rank 0 for both secrets -> a single guess solves both -> 100%.
    const t = progressTrajectory(holes, two, ['w0']);
    expect(t[0]).toBeCloseTo(100, 9);
  });
});

describe('buildShareText — spoiler-free Wordle-style grid', () => {
  const trajectory = [12, 45, 100];

  it('header carries the day number and score; one grid line per guess', () => {
    const text = buildShareText({ dayNumber: 7, guessCount: 3, trajectory });
    const lines = text.split('\n').filter(Boolean);
    expect(lines[0]).toBe('Whippin AI #7 — SCORE 3');
    expect(lines.slice(1)).toEqual(['🟥 12%', '🟪 45%', '🟦 100%']);
  });

  it('omits the day number for an override (no day)', () => {
    const text = buildShareText({ dayNumber: null, guessCount: 3, trajectory });
    expect(text.split('\n')[0]).toBe('Whippin AI — SCORE 3');
  });

  it('appends the url when given, and never leaks a word (no letters in the grid)', () => {
    const text = buildShareText({ dayNumber: 7, guessCount: 3, trajectory, url: 'https://whippin.ai' });
    expect(text.endsWith('https://whippin.ai')).toBe(true);
    const grid = text.split('\n\n')[1];
    expect(grid).not.toMatch(/[a-z]/i); // emojis + numbers + % only, no spoilers
  });
});
