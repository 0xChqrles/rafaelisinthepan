// Solved-screen share (issue #8).
//
// The per-guess progress trajectory is collapsed into a BOUNDED number of squares (3..18,
// more squares = more tries, on a hardcoded curve), each colored by the MEAN progress of its
// bucket. Those squares drive both the on-screen grid AND the shareable card: the result is
// packed into a URL token and shared as `<origin>/s/<token>`, so pasting the link unfurls
// into the rendered image (row of squares + SCORE + #day) instead of an emoji string.

import { computeProgress } from './scoring';
import { encodeResult, type RankMap, type RuntimeHole, type ShareResult } from '@whippin/shared';

// Reconstruction-% trajectory: replay the ordered valid guesses against the puzzle to
// get the reconstruction % AFTER each guess. A guess improves a hole exactly when the
// typed slug is in that hole's rank map with a rank BELOW the hole's current rank — the
// same rule as the live game loop (Game.submit). Starts from `freshHoles` (each at its
// start_rank). Monotonic non-decreasing; the final guess (which solved the sentence)
// lands at 100. One value per guess, so `.length === guessCount`.
export function progressTrajectory(freshHoles: RuntimeHole[], ranks: RankMap, tried: string[]): number[] {
  const holes = freshHoles.map((h) => ({ ...h }));
  const out: number[] = [];
  for (const typed of tried) {
    for (const h of holes) {
      if (h.rank === 0) continue; // solved holes are locked, exactly as in-game
      const entry = ranks[h.secret]?.[typed];
      if (entry && entry.rank < h.rank) h.rank = entry.rank;
    }
    out.push(computeProgress(holes, ranks));
  }
  return out;
}

// How many squares to show for a game of `tries` guesses. Minimum 3 (there are always 3
// holes needing 3 distinct words, so a perfect score is 3), up to MAX_SQUARES. Each
// breakpoint is the tries count at which one more square is earned; the ranges are
// hardcoded (not a formula) so they are exactly the chosen ones. Half-open: `tries >= t`.
export const SQUARE_BREAKPOINTS = [4, 6, 10, 15, 22, 33, 48, 70, 100, 120, 150, 180, 215, 255, 300];
export const MIN_SQUARES = 3;
export const MAX_SQUARES = MIN_SQUARES + SQUARE_BREAKPOINTS.length; // 18

export function squareCount(tries: number): number {
  let m = MIN_SQUARES;
  for (const t of SQUARE_BREAKPOINTS) {
    if (tries >= t) m += 1;
    else break; // breakpoints ascend, so the first miss ends it
  }
  return m;
}

// Collapse the per-guess trajectory into squareCount(n) contiguous, as-equal-as-possible
// buckets; each square's value is the MEAN progress % of its bucket. Because progress is
// monotonic non-decreasing and the buckets are contiguous, the means are too — so the row
// always reads cold -> hot. squareCount(n) <= n (equal only at n=3), so no bucket is empty.
export function bucketMeans(trajectory: number[]): number[] {
  const n = trajectory.length;
  if (n === 0) return [];
  const m = Math.min(squareCount(n), n);
  const out: number[] = [];
  for (let i = 0; i < m; i += 1) {
    const start = Math.floor((i * n) / m);
    const end = Math.floor(((i + 1) * n) / m);
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += trajectory[j];
    out.push(sum / (end - start));
  }
  return out;
}

// The shareable link: the result packed into a URL-safe token at `<origin>/s/<token>` (the
// codec lives in @whippin/shared, so the backend decodes the same token to render the card).
// Pasting the link unfurls into the OG image instead of a string of emoji.
export function shareUrl(origin: string, result: ShareResult): string {
  return `${origin}/s/${encodeResult(result)}`;
}
