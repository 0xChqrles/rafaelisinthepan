// Reconstruction progress.
//
//   s(rank)  = 1 - ln(rank + 1) / ln(N + 1)            // s(0) = 1 (solved)
//   p_hole   = (s(rank) - s(start_rank)) / (1 - s(start_rank))   // 0 at start, 1 solved
//   progress% = 100 * average(p_hole)
//
// N = number of keys in ranks[secret].

import type { RankMap, RuntimeHole } from '@word-hunt/shared';

export function s(rank: number, N: number) {
  return 1 - Math.log(rank + 1) / Math.log(N + 1);
}

export function holeProgress(rank: number, startRank: number, N: number) {
  const sStart = s(startRank, N);
  const denom = 1 - sStart;
  if (denom <= 0) return rank <= 0 ? 1 : 0; // start already perfect -> avoid /0
  const p = (s(rank, N) - sStart) / denom;
  return Math.max(0, Math.min(1, p));
}

export function computeProgress(holes: RuntimeHole[], ranks: RankMap) {
  if (!holes.length) return 0;
  let sum = 0;
  for (const h of holes) {
    const N = Object.keys(ranks[h.secret]).length;
    sum += holeProgress(h.rank, h.startRank, N);
  }
  return (100 * sum) / holes.length;
}
