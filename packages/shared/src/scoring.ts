// What a sentence round's guess log MEANS — the readings BOTH ends perform since #203.
//
// Until then this was the web's own arithmetic: the client counted its tries, computed its
// reconstruction percentage, and CLAIMED the resulting score to /scores. With the log
// server-side (#201) the server derives all three itself — `solved` and `progress` onto the
// round row on every append, and the score when the round finishes — so the formulas became
// a cross-package contract. Two spellings would let the number on screen disagree with the
// one the leaderboard recorded and the calendar (#211) fills from, over the same log.
//
//   s(rank)   = 1 - ln(rank + 1) / ln(N + 1)                       // s(0) = 1 (solved)
//   p_hole    = (s(rank) - s(start_rank)) / (1 - s(start_rank))    // 0 at start, 1 solved
//   progress% = 100 * average(p_hole over UNIQUE secret slugs)
//
// N = the number of RANKED GROUPS in one secret's map: the count of DISTINCT rank values.
// Inflected forms alias to their group's entry (#104), so the raw key count would
// over-count. Duplicate rendered occurrences of one secret slug share one logical target.

import type { RankEntry, RankMap } from './types';

export function s(rank: number, N: number): number {
  return 1 - Math.log(rank + 1) / Math.log(N + 1);
}

// N for one secret: how many distinct rank values its map holds (see the header).
// Cached per map OBJECT: a puzzle's rank maps are immutable and alias-expanded to tens of
// thousands of keys (#104), and this runs inside a per-guess replay — uncached, every
// counted try walked every key once per PRIOR try, a linear per-submit stall that froze the
// page by mid-round. The server pays the same walk per append, over an artifact it keeps.
const rankCountCache = new WeakMap<Record<string, RankEntry>, number>();
export function rankCount(rankMap: Record<string, RankEntry>): number {
  const cached = rankCountCache.get(rankMap);
  if (cached !== undefined) return cached;
  const seen = new Set<number>();
  for (const key in rankMap) seen.add(rankMap[key].rank);
  rankCountCache.set(rankMap, seen.size);
  return seen.size;
}

// One hole's share of the reconstruction, clamped to [0, 1].
export function holeProgress(rank: number, startRank: number, N: number): number {
  const sStart = s(startRank, N);
  const denom = 1 - sStart;
  if (denom <= 0) return rank <= 0 ? 1 : 0; // start already perfect -> avoid /0
  const p = (s(rank, N) - sStart) / denom;
  return Math.max(0, Math.min(1, p));
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
// itself) lost the solve. Comparing the whole outcome makes that unrepresentable — a guess
// that can move any hole always counts, so replaying `tried` always reproduces the board.
export function guessKey(ranks: RankMap, typed: string): string {
  const resolved = Object.keys(ranks).map((secret) => ranks[secret][typed]?.rank ?? -1);
  return resolved.some((rank) => rank >= 0) ? resolved.join('|') : typed;
}

// THE SENTENCE SCORE: how many UNIQUE tries a raw log holds. The web's own `tried` is
// deduped as it is written, so its length already IS this; the server reads a log two
// devices may have merged into it, where the same identity can appear twice under different
// surfaces (#104), and must dedup before counting. One function, so the number the player
// watches and the number the population records are the same number.
export function countTries(ranks: RankMap, log: readonly string[]): number {
  const seen = new Set<string>();
  for (const typed of log) seen.add(guessKey(ranks, typed));
  return seen.size;
}
