// Solved-screen share (issue #8).
//
// The result is packed into a URL token and shared as `<origin>/s/<token>`, so pasting the
// link unfurls into the rendered image instead of an emoji string. The CARD gets the raw
// per-guess trajectory + solve moments (v2 token, decided 2026-07-25) and draws the RUN RULER
// the solved screen shows. The plain-text emoji row is that same ruler, cell for cell.

import { computeProgress } from './scoring';
import {
  encodeResult,
  progressEmoji,
  type RankMap,
  type RuntimeHole,
  type ShareResult,
} from '@whippin/shared';

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

// The shareable link: the result packed into a URL-safe token at `<origin>/s/<token>` (the
// codec lives in @whippin/shared, so the backend decodes the same token to render the card).
// Pasting the link unfurls into the OG image instead of a string of emoji.
export function shareUrl(origin: string, result: ShareResult): string {
  return `${origin}/s/${encodeResult(result)}`;
}

// The RULER in plain text: ONE emoji per counted try, straight off the trajectory, on the
// SAME progress ramp (`progressEmoji` sits with the ramp stops in @whippin/shared, so the two
// can't drift). This row is the fallback where no card image renders — SMS, forwarded or
// plain-text messages, preview-less clients — so it is the card's bar cell for cell, not a
// summary of it: NO bucketing, NO means, NO fixed square count (decided 2026-07-25, retiring
// the bounded 3..18 row). A long run therefore makes a long row, exactly as it makes a long
// bar.
//
// Emoji, NOT the ramp's hexes: the row has to survive contexts with zero rendering support
// beyond Unicode. The ticks are the one thing the bar has and this doesn't — a single line has
// nowhere to put a mark BETWEEN two cells, and no second line to number it on.
export function emojiRow(trajectory: number[]): string {
  return trajectory.map(progressEmoji).join('');
}

// The shared/copied plain text: the headline, then the emoji ruler on its own line (attached
// to the headline block), a blank line for unfurl separation, then the (unfurling) link. Pure
// + i18n-free (the caller localizes `headline`) so the composition is unit-testable without
// the DOM. Same trajectory the token carries, so link and row can never disagree.
export function shareText(headline: string, trajectory: number[], url: string): string {
  return `${headline}\n${emojiRow(trajectory)}\n\n${url}`;
}
