// CONTRACT: reconstruction progress over the SCREEN's runtime holes
// (packages/web/src/game/scoring.ts `computeProgress`), asserted against the SPEC in
// AGENTS.md ("### Progress"):
//   progress% = 100 * average(p_hole over UNIQUE secret slugs)
// The curve under it (`s`, `holeProgress`), `rankCount` and `guessKey` are
// @whippin/shared's since #203 and are contract-tested there.
//
// The model is path-INDEPENDENT (progress depends only on each logical target's CURRENT
// rank). "Collateral neutralization" is tested as that model expresses it: a collateral
// nudge then a later solve equals the single merged solve EXACTLY — fragments never
// double-count.

import { describe, it, expect } from 'vitest';
import { computeProgress, rankCount, replayHoles } from './scoring';
import type { RankMap } from '@whippin/shared';
import type { RuntimeHole } from './types';

// A rank map for one secret with exactly N entries -> N = number of keys.
function mk(N: number): RankMap[string] {
  const inner: RankMap[string] = {};
  for (let i = 0; i < N; i++) inner[`w${i}`] = { word: `w${i}`, rank: i };
  return inner;
}
function hole(secret: string, rank: number, startRank: number): RuntimeHole {
  return { pos: 0, secret, word: secret, rank, startRank };
}

describe('computeProgress(holes, ranks) — averaged, 0..100, path-independent', () => {
  it('is 0% at the start and 100% when every hole is solved', () => {
    const ranks: RankMap = { a: mk(1000), b: mk(500) };
    const atStart: RuntimeHole[] = [hole('a', 300, 300), hole('b', 80, 80)];
    expect(computeProgress(atStart, ranks)).toBeCloseTo(0, 9);

    // all-holes-in-one-jump => fully reconstructed == 100 (the 0..100 scale IS the
    // normalizer — no separate perfect/SCALE constant exists).
    const allSolved: RuntimeHole[] = [hole('a', 0, 300), hole('b', 0, 80)];
    expect(computeProgress(allSolved, ranks)).toBeCloseTo(100, 9);
  });

  it('collateral neutralization: a collateral nudge then a later primary solve == the single merged solve', () => {
    // Hole B starts at rank 80. One guess COLLATERALLY nudges it to rank 30; a later
    // guess SOLVES it (rank 0). Because progress is determined by the CURRENT rank,
    // the merged outcome equals solving in a single jump 80 -> 0 EXACTLY — the
    // intermediate fragment does not add on top.
    const ranks: RankMap = { b: mk(500) };
    const fresh = [hole('b', 80, 80)];
    const after = (tried: string[]) => computeProgress(replayHoles(fresh, ranks, tried), ranks);
    const directSolve = after(['w0']); // one jump 80 -> 0
    const afterNudge = after(['w30']); // collateral 80 -> 30
    const afterSolve = after(['w30', 'w0']); // then 30 -> 0

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

describe('replayHoles(freshHoles, ranks, tried) — the board as the log describes it', () => {
  const ranks: RankMap = {
    foret: {
      foret: { word: 'forêt', rank: 0 },
      bois: { word: 'bois', rank: 5 },
      lisiere: { word: 'lisière', rank: 12 },
      chemin: { word: 'chemin', rank: 87 },
    },
    ancienne: {
      ancienne: { word: 'ancienne', rank: 0 },
      vieille: { word: 'vieille', rank: 40 },
    },
  };

  // Two holes at their start ranks — the fresh state a round begins from.
  function freshHoles(): RuntimeHole[] {
    return [
      { pos: 1, secret: 'foret', word: 'bois', rank: 87, startRank: 87 },
      { pos: 2, secret: 'ancienne', word: 'vieille', rank: 40, startRank: 40 },
    ];
  }

  it('walks the log under the game-loop rule: closer word + lower rank, solved locked', () => {
    const fresh = freshHoles();
    const holes = replayHoles(fresh, ranks, ['bois', 'ancienne']);
    expect(holes[0]).toMatchObject({ word: 'bois', rank: 5 }); // improved
    expect(holes[1]).toMatchObject({ word: 'ancienne', rank: 0 }); // solved
    // The fresh template is never mutated.
    expect(fresh).toEqual(freshHoles());
  });

  it('an improving guess leaves the hole on the entry\'s ACCENTED word, never the typed slug', () => {
    // The player types folded slugs; what the hole displays is the group's accented form.
    expect(replayHoles(freshHoles(), ranks, ['lisiere'])[0]).toMatchObject({ word: 'lisière', rank: 12 });
    expect(replayHoles(freshHoles(), ranks, ['lisiere', 'foret'])[0]).toMatchObject({ word: 'forêt', rank: 0 });
  });
});
