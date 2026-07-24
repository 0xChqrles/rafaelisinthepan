// Reconstruction progress.
//
//   s(rank)  = 1 - ln(rank + 1) / ln(N + 1)            // s(0) = 1 (solved)
//   p_hole   = (s(rank) - s(start_rank)) / (1 - s(start_rank))   // 0 at start, 1 solved
//   progress% = 100 * average(p_hole over UNIQUE secret slugs)
//
// N = number of RANKED GROUPS in ranks[secret]: the count of distinct rank values.
// Inflected forms alias to their group's entry (#104), so the raw key count would
// over-count; on an alias-free (pre-#104) puzzle every key has its own rank and the
// two counts are identical. Duplicate rendered occurrences of one secret slug share
// one logical progress target.

import type { RankEntry, RankMap, RuntimeHole } from '@whippin/shared';

export function s(rank: number, N: number) {
  return 1 - Math.log(rank + 1) / Math.log(N + 1);
}

// N for one secret: how many distinct rank values its map holds (see header comment).
// Cached per map object: a puzzle's rank maps are immutable and alias-expanded to tens
// of thousands of keys (#104), and this runs inside progressTrajectory's per-guess
// replay — uncached, every counted try walked every key once per PRIOR try, a linear
// per-submit stall that froze the page for hundreds of ms by mid-round.
const rankCountCache = new WeakMap<Record<string, RankEntry>, number>();
export function rankCount(rankMap: Record<string, RankEntry>): number {
  const cached = rankCountCache.get(rankMap);
  if (cached !== undefined) return cached;
  const seen = new Set<number>();
  for (const key in rankMap) seen.add(rankMap[key].rank);
  rankCountCache.set(rankMap, seen.size);
  return seen.size;
}

// Canonical dedup identity of a valid folded guess (#104): inflections of one word are
// aliases of one rank entry, so they are ONE counted try. The first secret (JSON key
// order) whose map knows the guess anchors the identity — aliasing is consistent across
// maps, so every variant of a word resolves to the same (secret, rank) pair. A guess
// found in no map (a cold miss everywhere) keeps its folded slug as its identity.
export function guessKey(ranks: RankMap, typed: string): string {
  for (const secret of Object.keys(ranks)) {
    const entry = ranks[secret][typed];
    if (entry) return `${secret}:${entry.rank}`;
  }
  return typed;
}

export function holeProgress(rank: number, startRank: number, N: number) {
  const sStart = s(startRank, N);
  const denom = 1 - sStart;
  if (denom <= 0) return rank <= 0 ? 1 : 0; // start already perfect -> avoid /0
  const p = (s(rank, N) - sStart) / denom;
  return Math.max(0, Math.min(1, p));
}

export function computeProgress(holes: RuntimeHole[], ranks: RankMap) {
  // A repeated sentence occurrence is still its own rendered/runtime hole, but it is
  // not a second logical target for reconstruction progress. Generation gives all
  // occurrences of one secret slug the same start state, and the game updates them in
  // lockstep; keep the first occurrence as the representative for that shared target.
  const uniqueHoles: RuntimeHole[] = [];
  const seenSecrets = new Set<string>();
  for (const hole of holes) {
    if (seenSecrets.has(hole.secret)) continue;
    seenSecrets.add(hole.secret);
    uniqueHoles.push(hole);
  }

  if (!uniqueHoles.length) return 0;
  let sum = 0;
  for (const h of uniqueHoles) {
    const N = rankCount(ranks[h.secret]);
    sum += holeProgress(h.rank, h.startRank, N);
  }
  return (100 * sum) / uniqueHoles.length;
}
