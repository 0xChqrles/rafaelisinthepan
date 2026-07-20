// CONTRACT: reconstruction progress (packages/web/src/game/scoring.ts), asserted
// against the SPEC in AGENTS.md ("### Progress"):
//   s(rank)   = 1 - ln(rank+1)/ln(N+1)          // s(0) = 1 (solved = perfect)
//   p_hole    = (s(rank) - s(start_rank)) / (1 - s(start_rank))   // 0 at start, 1 solved
//   progress% = 100 * average(p_hole over UNIQUE secret slugs)
//
// NOTE (discrepancy, see the agent's report): the /goal brief described a DIFFERENT
// scoring model — per-guess "contribution", a "perfect" baseline, and
// finalScore = round(rawScore/perfect*SCALE) with strict convexity (one jump > two
// jumps). That model is NOT in this repo or AGENTS.md. The real model is
// path-INDEPENDENT (progress depends only on each logical target's CURRENT rank), so we lock
// that actual contract here. "Collateral neutralization" is tested as the real
// model expresses it: a collateral nudge then a later solve equals the single merged
// solve EXACTLY — fragments never double-count.

import { describe, it, expect } from 'vitest';
import { s, holeProgress, computeProgress, rankCount, guessKey } from './scoring';
import type { RankMap, RuntimeHole } from '@whippin/shared';

// A rank map for one secret with exactly N entries -> N = number of keys.
function mk(N: number): RankMap[string] {
  const inner: RankMap[string] = {};
  for (let i = 0; i < N; i++) inner[`w${i}`] = { word: `w${i}`, rank: i };
  return inner;
}
function hole(secret: string, rank: number, startRank: number): RuntimeHole {
  return { pos: 0, secret, word: secret, rank, startRank };
}

describe('s(rank, N)', () => {
  const N = 1000;
  it('s(0) === 1 — a solved hole is perfect', () => {
    expect(s(0, N)).toBe(1);
  });
  it('is strictly decreasing in rank (closer = higher)', () => {
    for (const [a, b] of [[1, 2], [2, 10], [10, 100], [100, 999]]) {
      expect(s(a, N)).toBeGreaterThan(s(b, N));
    }
  });
});

describe('holeProgress(rank, startRank, N)', () => {
  const N = 1000;
  const start = 200;
  it('is 0 at the start rank', () => {
    expect(holeProgress(start, start, N)).toBeCloseTo(0, 12);
  });
  it('is 1 when solved (rank 0)', () => {
    expect(holeProgress(0, start, N)).toBeCloseTo(1, 12);
  });
  it('clamps to 0 when the current rank is worse (larger) than the start', () => {
    expect(holeProgress(start + 100, start, N)).toBe(0);
  });
  it('handles a start that is already perfect (start_rank 0) without /0', () => {
    expect(holeProgress(0, 0, N)).toBe(1);
    expect(holeProgress(5, 0, N)).toBe(0);
  });
  it('is monotonic: a lower (closer) rank never scores lower', () => {
    expect(holeProgress(50, start, N)).toBeGreaterThan(holeProgress(150, start, N));
  });
});

describe('computeProgress(holes, ranks) — averaged, 0..100, path-independent', () => {
  it('is 0% at the start and 100% when every hole is solved', () => {
    const ranks: RankMap = { a: mk(1000), b: mk(500) };
    const atStart: RuntimeHole[] = [hole('a', 300, 300), hole('b', 80, 80)];
    expect(computeProgress(atStart, ranks)).toBeCloseTo(0, 9);

    // all-holes-in-one-jump => fully reconstructed == 100 (the real model's analog of
    // the brief's "normalized == 1"; the 0..100 scale IS the normalizer — no separate
    // perfect/SCALE constant exists).
    const allSolved: RuntimeHole[] = [hole('a', 0, 300), hole('b', 0, 80)];
    expect(computeProgress(allSolved, ranks)).toBeCloseTo(100, 9);
  });

  it('collateral neutralization: a collateral nudge then a later primary solve == the single merged solve', () => {
    // Hole B starts at rank 80. One guess COLLATERALLY nudges it to rank 30; a later
    // guess SOLVES it (rank 0). Because progress is determined by the CURRENT rank,
    // the merged outcome equals solving in a single jump 80 -> 0 EXACTLY — the
    // intermediate fragment does not add on top.
    const ranks: RankMap = { b: mk(500) };
    const directSolve = computeProgress([hole('b', 0, 80)], ranks); // one jump 80 -> 0
    const afterNudge = computeProgress([hole('b', 30, 80)], ranks); // collateral 80 -> 30
    const afterSolve = computeProgress([hole('b', 0, 80)], ranks); // then 30 -> 0

    expect(afterSolve).toBe(directSolve); // EXACTLY the merged jump, not the fragments
    expect(afterNudge).toBeGreaterThan(0);
    expect(afterNudge).toBeLessThan(directSolve);
  });

  it('averages holes equally (one of two solved ~= 50%)', () => {
    const ranks: RankMap = { a: mk(1000), b: mk(1000) };
    const half: RuntimeHole[] = [hole('a', 0, 300), hole('b', 300, 300)];
    expect(computeProgress(half, ranks)).toBeCloseTo(50, 9);
  });

  it('N counts ranked GROUPS, so alias keys (#104) do not distort the curve', () => {
    // Same 500 groups; the aliased map adds inflection keys pointing at existing
    // ranks. Progress must be identical — alias keys are lookup sugar, not vocabulary.
    const plain = mk(500);
    const aliased: RankMap[string] = { ...plain };
    for (let i = 0; i < 500; i += 5) aliased[`w${i}s`] = { word: `w${i}`, rank: i };

    expect(rankCount(aliased)).toBe(rankCount(plain));
    const at = (ranks: RankMap[string]) => computeProgress([hole('b', 30, 80)], { b: ranks });
    expect(at(aliased)).toBe(at(plain));
  });

  it('counts repeated occurrences as one logical target in the progress average', () => {
    const ranks: RankMap = { chat: mk(1000), garden: mk(1000) };
    const holes: RuntimeHole[] = [
      { pos: 1, secret: 'chat', word: 'chat', rank: 0, startRank: 300 },
      { pos: 4, secret: 'chat', word: 'chat', rank: 0, startRank: 300 },
      { pos: 7, secret: 'garden', word: 'park', rank: 300, startRank: 300 },
    ];

    // The solved repeated chat occurrence contributes once, so one of the two logical
    // targets is complete: 50%, not 66.67% (or 33.33% if occurrences were weighted).
    expect(computeProgress(holes, ranks)).toBeCloseTo(50, 9);
  });
});

describe('guessKey(ranks, typed) — canonical try identity (#104)', () => {
  // "privée"/"prive" alias to the privé entry (rank 2) in secret a's map; secret b
  // knows neither. "portes" is an alias of a DIFFERENT group (porte, rank 5).
  const ranks: RankMap = {
    a: {
      prive: { word: 'privé', rank: 2 },
      privee: { word: 'privé', rank: 2 },
      porte: { word: 'porte', rank: 5 },
      portes: { word: 'porte', rank: 5 },
    },
    b: {
      prive: { word: 'privé', rank: 90 },
      privee: { word: 'privé', rank: 90 },
    },
  };

  it('two inflections of one word share one identity', () => {
    expect(guessKey(ranks, 'privee')).toBe(guessKey(ranks, 'prive'));
  });

  it('different words (even aliased ones) keep distinct identities', () => {
    expect(guessKey(ranks, 'porte')).not.toBe(guessKey(ranks, 'prive'));
    expect(guessKey(ranks, 'portes')).toBe(guessKey(ranks, 'porte'));
  });

  it('anchors on the FIRST map that knows the guess, consistently across variants', () => {
    // Both variants exist in a and b: the identity comes from a (JSON key order), so
    // the differing rank in b never splits them.
    expect(guessKey(ranks, 'privee')).toBe('a:2');
  });

  it('a guess in no map (cold miss) keeps its folded slug as identity', () => {
    expect(guessKey(ranks, 'ailleurs')).toBe('ailleurs');
    expect(guessKey(ranks, 'ailleurs')).not.toBe(guessKey(ranks, 'autre'));
  });
});
