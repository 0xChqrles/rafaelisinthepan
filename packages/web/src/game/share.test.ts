// CONTRACT: the solved-screen share (issue #8, packages/web/src/game/share.ts), asserted
// against the agreed design:
//   - the per-guess progress trajectory (and the solve moments behind the ruler's ticks) are
//     replayed from the ordered guesses;
//   - the result is shared as a link `<origin>/s/<token>` that the backend unfurls into the
//     card image — the RAW run since the v2 token, so the card draws the same ruler as the
//     solved screen (the codec itself is contract-tested in @whippin/shared);
//   - the plain-text emoji row is that ruler CELL FOR CELL: one emoji per counted try, no
//     bucketing and no mean (the bounded 3..18 row was retired 2026-07-25).

import { describe, it, expect } from 'vitest';
import { progressTrajectory, solveTicks, emojiRow, shareText, shareUrl } from './share';
import { computeProgress } from './scoring';
import { decodeResult, progressEmoji, type RankMap, type RuntimeHole } from '@whippin/shared';

// A rank map for one secret with N entries -> N keys, `wI` at rank I (so `w0` == solved).
function mk(N: number): RankMap[string] {
  const inner: RankMap[string] = {};
  for (let i = 0; i < N; i++) inner[`w${i}`] = { word: `w${i}`, rank: i };
  return inner;
}
function hole(secret: string, startRank: number): RuntimeHole {
  return { pos: 0, secret, word: secret, rank: startRank, startRank };
}

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

  it('replays a shared secret across duplicate positions and solves both instances', () => {
    const ranks: RankMap = { chat: mk(1000) };
    const holes: RuntimeHole[] = [
      { pos: 1, secret: 'chat', word: 'animal', rank: 300, startRank: 300 },
      { pos: 4, secret: 'chat', word: 'bête', rank: 300, startRank: 300 },
    ];

    const trajectory = progressTrajectory(holes, ranks, ['w200', 'w0']);
    expect(trajectory).toHaveLength(2);
    expect(trajectory[0]).toBeGreaterThan(0);
    expect(trajectory[1]).toBeCloseTo(100, 9);
  });
});

describe('solveTicks — solve moments per distinct secret, in sentence order', () => {
  it('records the 1-based try that solved each secret, in first-occurrence order', () => {
    // b's map only knows 'bb' (its secret): try 1 misses everything, try 2 solves b,
    // try 4 solves a — so the sentence-order result is [4, 2], not guess order.
    const ranks: RankMap = { a: mk(1000), b: { bb: { word: 'bb', rank: 0 } } };
    const holes: RuntimeHole[] = [hole('a', 300), { ...hole('b', 200), pos: 3 }];
    expect(solveTicks(holes, ranks, ['zzz', 'bb', 'w50', 'w0'])).toEqual([4, 2]);
  });

  it('one guess dropping several secrets gives each the SAME try (one shared tick)', () => {
    const ranks: RankMap = { a: mk(1000), b: mk(1000) };
    const holes: RuntimeHole[] = [hole('a', 300), { ...hole('b', 300), pos: 2 }];
    expect(solveTicks(holes, ranks, ['w200', 'w0'])).toEqual([2, 2]);
  });

  it('a run that never solves a secret leaves null for it (DNF opponents)', () => {
    const ranks: RankMap = { a: mk(1000), b: mk(1000) };
    const holes: RuntimeHole[] = [hole('a', 300), { ...hole('b', 300), pos: 2 }];
    expect(solveTicks(holes, ranks, ['w200', 'w100'])).toEqual([null, null]);
  });

  it('a repeated secret is ONE entry: all its occurrences solve on the same guess', () => {
    const ranks: RankMap = { chat: mk(1000) };
    const holes: RuntimeHole[] = [
      { pos: 1, secret: 'chat', word: 'animal', rank: 300, startRank: 300 },
      { pos: 4, secret: 'chat', word: 'bête', rank: 300, startRank: 300 },
    ];
    expect(solveTicks(holes, ranks, ['w200', 'w0'])).toEqual([2]);
  });
});

describe('emojiRow — the RULER in plain text (fallback where no card image renders)', () => {
  it('walks the same PROGRESS ramp as the ruler, not a second palette', () => {
    // One value squarely inside each band; the bands themselves are contract-tested
    // against the ramp in @whippin/shared (progressColor.test.ts).
    expect(emojiRow([10, 40, 50, 60, 70, 90])).toBe('🟦🟩🟨🟧🟥🟪');
    expect(emojiRow([10, 40, 50, 60, 70, 90])).toBe(
      [10, 40, 50, 60, 70, 90].map(progressEmoji).join(''),
    );
  });

  it('ends a solved run on the ramp top, distinct from an untouched start', () => {
    expect(emojiRow([100])).toBe('🟪');
    expect(emojiRow([0])).toBe('🟦');
  });

  it('is ONE emoji per counted try — never bucketed, never averaged', () => {
    // A 137-try run gives a 137-emoji row, not a bounded summary of one. Each colored-square
    // emoji is a single code point (2 UTF-16 units).
    const traj = Array.from({ length: 137 }, (_, i) => (100 * (i + 1)) / 137);
    expect([...emojiRow(traj)]).toHaveLength(137);
    // And each cell is ITS OWN try's value: a run that stalls repeats the emoji rather than
    // smoothing the plateau into a mean the way the old bucketed row did.
    expect(emojiRow([0, 0, 0, 100])).toBe('🟦🟦🟦🟪');
  });

  it('carries the run end to end — the last emoji IS the solving try', () => {
    // The old bucketed row averaged the tail, so a long grind that solved on the last guess
    // could end mid-ramp. One cell per try cannot: 100 is the final cell.
    const grind = [...Array(60).fill(70), 100];
    const row = [...emojiRow(grind)];
    expect(row).toHaveLength(61);
    expect(row[row.length - 1]).toBe('🟪');
  });

  it('handles no guesses without throwing', () => {
    expect(emojiRow([])).toBe('');
  });
});

describe('shareText — headline, emoji ruler, blank line, URL in order', () => {
  it('composes the four parts on the agreed lines', () => {
    const text = shareText('Whippin #12 — 3 tries', [10, 50, 90], 'https://whippin.ai/s/tok');
    expect(text).toBe('Whippin #12 — 3 tries\n🟦🟨🟪\n\nhttps://whippin.ai/s/tok');
  });

  it('keeps the row attached to the headline and a blank line before the (unfurling) URL', () => {
    const headline = 'Whippin #7 — 3 tries';
    const url = 'https://whippin.ai/s/abc';
    const trajectory = [40, 70, 100];
    const lines = shareText(headline, trajectory, url).split('\n');
    expect(lines[0]).toBe(headline); // headline first
    expect(lines[1]).toBe(emojiRow(trajectory)); // row on its own line, under the headline
    expect(lines[2]).toBe(''); // blank line preserves the OG-unfurl separation
    expect(lines[3]).toBe(url); // link last
  });

  it('the row is exactly as long as the run (the headline count and the row agree)', () => {
    const trajectory = Array.from({ length: 9 }, (_, i) => 10 * (i + 1));
    const lines = shareText('Whippin #7 — 9 tries', trajectory, 'https://x/y').split('\n');
    expect([...lines[1]]).toHaveLength(9);
  });
});

describe('shareUrl — result packed into a /s/<token> link', () => {
  // A real dayNumber (days since 1970 ≈ 20638 today) and a 3-try perfect game: the token
  // carries the RAW run + its solve moments, so the card draws the same ruler as the screen.
  const result = {
    lang: 'fr',
    dayNumber: 20638,
    score: 3,
    trajectory: [40, 70, 100],
    solvedAt: [1, 2, 3],
  };

  it('builds <origin>/s/<token> and the token round-trips the result', () => {
    const url = shareUrl('https://whippin.ai', result);
    expect(url.startsWith('https://whippin.ai/s/')).toBe(true);
    const decoded = decodeResult(url.slice('https://whippin.ai/s/'.length));
    expect(decoded?.lang).toBe('fr');
    expect(decoded?.dayNumber).toBe(20638);
    expect(decoded?.score).toBe(3);
    expect(decoded?.trajectory).toHaveLength(3); // one ruler cell per counted try
    expect(decoded?.solvedAt).toEqual([1, 2, 3]); // one ruler tick per secret
  });

  it('carries no spoilers — the sentence/words never appear in the link', () => {
    const url = shareUrl('https://whippin.ai', result);
    // Only the origin, the /s/ path, and a base64url token.
    expect(url).toMatch(/^https:\/\/whippin\.ai\/s\/[A-Za-z0-9_-]+$/);
  });
});
