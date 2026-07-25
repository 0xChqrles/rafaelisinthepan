// Solved-screen share (issue #8).
//
// The result is packed into a URL token and shared as `<origin>/s/<token>`, so pasting the
// link unfurls into the rendered image instead of an emoji string. The CARD gets the raw
// per-guess trajectory + solve moments (v2 token, decided 2026-07-25) and draws the same RUN
// RULER as the solved screen. The plain-text emoji row — the fallback where no image renders
// — still collapses that trajectory into a BOUNDED number of squares (3..18, more squares =
// more tries, on a hardcoded curve), each colored by the MEAN progress of its bucket.

import { computeProgress } from './scoring';
import {
  encodeResult,
  progressEmoji,
  squareCount,
  MIN_SQUARES,
  MAX_SQUARES,
  SQUARE_BREAKPOINTS,
  type RankMap,
  type RuntimeHole,
  type ShareResult,
} from '@whippin/shared';

// The square-count curve lives in shared (it used to drive the codec too; since v2 only the
// emoji row buckets); re-export it so the web's consumers/tests keep importing it from here.
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

// Solve moments for the run ruler: replay the same ordered guesses with the same
// improvement rule as progressTrajectory, and record for each DISTINCT secret (in
// sentence order — first occurrence's pos) the 1-based try that solved it, or null when
// the run never does (a DNF opponent). Every occurrence of a repeated secret solves on
// the same guess (they share one rank map), so one distinct secret = one tick.
export function solveTicks(
  freshHoles: RuntimeHole[],
  ranks: RankMap,
  tried: string[],
): (number | null)[] {
  const holes = freshHoles.map((h) => ({ ...h }));
  const secrets = holes.map((h) => h.secret).filter((s, i, a) => a.indexOf(s) === i);
  const out: (number | null)[] = secrets.map(() => null);
  tried.forEach((typed, i) => {
    for (const h of holes) {
      if (h.rank === 0) continue;
      const entry = ranks[h.secret]?.[typed];
      if (entry && entry.rank < h.rank) h.rank = entry.rank;
    }
    secrets.forEach((s, si) => {
      if (out[si] === null && holes.every((h) => h.secret !== s || h.rank === 0)) out[si] = i + 1;
    });
  });
  return out;
}

// Collapse the per-guess trajectory into EXACTLY squareCount(n) contiguous,
// as-equal-as-possible buckets; each square's value is the MEAN progress % of its bucket.
// Because progress is monotonic non-decreasing and the buckets are contiguous, the means
// are too — so the row always reads cold -> hot. This feeds the EMOJI row only (the card
// draws the raw run since the v2 token); the count stays squareCount(n) so the row's length
// still reads as "how long was this game". n >= squareCount(n) for any normal game (>= 3
// tries); below that (two holes sharing a secret solved by one word) buckets re-sample a
// guess so the row is never short.
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

// One emoji per share square, on the SAME progress ramp as the ruler (`progressEmoji` sits
// with the ramp stops in @whippin/shared, so the two can't drift). This row is the fallback
// where no card image renders — SMS, forwarded/plain-text messages, preview-less clients — so
// it must read as the card does: a bucketed summary of the same run, in the same colors, not
// a second visual language.
//
// Emoji, NOT the ramp's hexes, and BUCKETED where the card draws every try: the row has to
// survive contexts with zero rendering support beyond Unicode, and stay short enough to paste
// anywhere. Ticks are the one thing it drops — plain text has nowhere to put them.
export function emojiRow(squares: number[]): string {
  return squares.map(progressEmoji).join('');
}

// The shared/copied plain text: the headline, then the heat-square emoji row on its own line
// (attached to the headline block), a blank line for unfurl separation, then the (unfurling)
// link. Pure + i18n-free (the caller localizes `headline`) so the composition is unit-testable
// without the DOM. Same `squares` the card receives, so link and row can never disagree.
export function shareText(headline: string, squares: number[], url: string): string {
  return `${headline}\n${emojiRow(squares)}\n\n${url}`;
}
