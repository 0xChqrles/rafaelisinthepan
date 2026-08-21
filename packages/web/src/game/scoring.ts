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
// of thousands of keys (#104), and this runs inside replayRun's per-guess
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

// Canonical dedup identity of a valid folded guess (#104): two guesses are ONE counted try
// only when they are INDISTINGUISHABLE — every hole resolves them to the same entry, so the
// second can tell the player nothing the first didn't. The identity is therefore the guess's
// whole OUTCOME: its rank in each secret's map, in JSON key order, with -1 where a map does
// not know it. A guess found in no map (a cold miss everywhere) keeps its folded slug.
// Inflections of one word still collapse to one try — that is what aliasing to the same
// entry in every map MEANS.
//
// It used to anchor on the FIRST map that knew the guess, on the reasoning that "aliasing is
// consistent across maps, so every variant resolves to the same (secret, rank) pair". That
// reasoning is false: a slug collision is resolved PER MAP, closest-wins, so one map can fuse
// two surfaces that another map ranks far apart. On fr day 20667, `maniere` and `manieres`
// were one group in the FIRST map (tropiques', where both fold onto `maniérés`, rank 6783)
// while in the `manieres` hole's own map they were rank 2 and rank 0 — so the guess that
// SOLVED that hole was dropped as a repeat of the singular, never entered `tried`, and every
// view replayed from `tried` (the run ruler, the share card, the emoji row, and the score
// itself) lost the solve: the shared card showed no tick for the middle word and a run that
// never reached 100%. Comparing the whole outcome makes that unrepresentable — a guess that
// can move any hole always counts, so replaying `tried` always reproduces the board.
export function guessKey(ranks: RankMap, typed: string): string {
  const resolved = Object.keys(ranks).map((secret) => ranks[secret][typed]?.rank ?? -1);
  return resolved.some((rank) => rank >= 0) ? resolved.join('|') : typed;
}

// The game loop's improvement rule, stated ONCE: a valid guess moves every UNSOLVED hole
// whose map ranks it closer, swapping in the entry's accented word and lower rank
// (solved holes are locked). Mutates `holes` in place — callers replay onto fresh copies.
// Game.submit defers its animated swaps to the floating hit's fade-out; every REPLAY of a
// log (the run ruler below, and #201's server-log adoption) applies this directly,
// because both rest on the same contract: `tried` is a complete record of the state
// changes, so walking it under this rule always lands on the real board.
export function applyGuessToHoles(holes: RuntimeHole[], ranks: RankMap, typed: string): void {
  for (const h of holes) {
    if (h.rank === 0) continue; // solved holes are locked, exactly as in-game
    const entry = ranks[h.secret]?.[typed];
    if (entry && entry.rank < h.rank) {
      h.rank = entry.rank;
      h.word = entry.word;
    }
  }
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
