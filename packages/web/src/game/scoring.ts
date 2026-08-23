// The round's reading of its own log, on RuntimeHoles.
//
// The arithmetic itself moved to `@whippin/shared` with #203: the server now derives a
// round's `solved`, its `progress` and its score from the stored guess log, so `s`,
// `rankCount`, `holeProgress`, `guessKey` and `countTries` are a cross-package contract and
// live in one place. What stays here is what only the SCREEN has — the runtime holes and
// the improvement rule that walks them.

import type { RankMap, RuntimeHole } from '@whippin/shared';
import { holeProgress, rankCount } from '@whippin/shared';

export { countTries, guessKey, holeProgress, rankCount, s } from '@whippin/shared';

// The game loop's improvement rule, stated ONCE: a valid guess moves every UNSOLVED hole
// whose map ranks it closer, swapping in the entry's accented word and lower rank
// (solved holes are locked). Mutates `holes` in place — callers replay onto fresh copies.
// Game.submit defers its animated swaps to the floating hit's fade-out; every REPLAY of a
// log (the run ruler, and #201's server-log adoption) applies this directly, because both
// rest on the same contract: `tried` is a complete record of the state changes, so walking
// it under this rule always lands on the real board.
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

// A whole log replayed onto fresh holes — the board as the play log describes it. Since
// #214 this is how the screen HOLDS its board: nothing persists holes any more, so what is
// on screen is a projection of the log like everything else. The animated swap a live guess
// earns is a presentation lag over the same function (Game defers the guess itself, not the
// board's arithmetic), which is why a replay can be authoritative and instant at once.
export function replayHoles(
  freshHoles: RuntimeHole[],
  ranks: RankMap,
  tried: readonly string[],
): RuntimeHole[] {
  const holes = freshHoles.map((h) => ({ ...h }));
  for (const typed of tried) applyGuessToHoles(holes, ranks, typed);
  return holes;
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
