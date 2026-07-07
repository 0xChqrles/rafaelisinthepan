// Solved-screen share (issue #8).
//
// The per-guess progress trajectory is collapsed into a BOUNDED number of squares (3..18,
// more squares = more tries, on a hardcoded curve), each colored by the MEAN progress of its
// bucket. Those squares drive both the on-screen grid AND the shareable card: the result is
// packed into a URL token and shared as `<origin>/s/<token>`, so pasting the link unfurls
// into the rendered image (row of squares + SCORE + #day) instead of an emoji string.

import { computeProgress } from './scoring';
import {
  encodeResult,
  squareCount,
  MIN_SQUARES,
  MAX_SQUARES,
  SQUARE_BREAKPOINTS,
  type RankMap,
  type RuntimeHole,
  type ShareResult,
} from '@whippin/shared';

// The square-count contract lives in shared now (the decoder derives it from the score);
// re-export it so the web's consumers/tests keep importing it from here.
export { squareCount, MIN_SQUARES, MAX_SQUARES, SQUARE_BREAKPOINTS };

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

// Collapse the per-guess trajectory into EXACTLY squareCount(n) contiguous,
// as-equal-as-possible buckets; each square's value is the MEAN progress % of its bucket.
// Because progress is monotonic non-decreasing and the buckets are contiguous, the means
// are too — so the row always reads cold -> hot. The count must be squareCount(n) and
// nothing else: the decoder derives it from the score alone, so a shorter row here would
// make the card pad phantom cold squares. n >= squareCount(n) for any normal game (>= 3
// tries); below that (two holes sharing a secret solved by one word) buckets re-sample a
// guess so the row still matches the decoder.
export function bucketMeans(trajectory: number[]): number[] {
  const n = trajectory.length;
  if (n === 0) return [];
  const m = squareCount(n);
  const out: number[] = [];
  for (let i = 0; i < m; i += 1) {
    const start = Math.floor((i * n) / m);
    const end = Math.max(start + 1, Math.floor(((i + 1) * n) / m));
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

// One emoji per share square — the SAME bucketMeans output that drives the card, so the row
// length (squareCount, 3..18) and its colors always agree with the rendered OG image. Bucketed
// on the heat ramp's arc (cold crimson -> hot cyan):
//   pct < 20 🟥, < 40 🟧, < 60 🟨, < 80 🟩, >= 80 🟦
// Emoji, NOT the heat hexes: the row must survive contexts with zero rendering support beyond
// Unicode (SMS, forwarded/plain-text messages, preview-less clients) — the plain-text fallback
// for the OG card, carrying the same information so the two never disagree.
export function emojiRow(squares: number[]): string {
  return squares
    .map((pct) => {
      if (pct < 20) return '🟥';
      if (pct < 40) return '🟧';
      if (pct < 60) return '🟨';
      if (pct < 80) return '🟩';
      return '🟦';
    })
    .join('');
}

// The shared/copied plain text: the headline, then the heat-square emoji row on its own line
// (attached to the headline block), a blank line for unfurl separation, then the (unfurling)
// link. Pure + i18n-free (the caller localizes `headline`) so the composition is unit-testable
// without the DOM. Same `squares` the card receives, so link and row can never disagree.
export function shareText(headline: string, squares: number[], url: string): string {
  return `${headline}\n${emojiRow(squares)}\n\n${url}`;
}
