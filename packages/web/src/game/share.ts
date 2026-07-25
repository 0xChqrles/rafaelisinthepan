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

// The ruler's two halves, replayed in ONE walk (they are the same walk: the same ordered
// guesses under the same improvement rule as the live game loop, Game.submit). Keeping
// them in one function is what stops the bar's cells and its ticks from ever disagreeing
// about the same run — and every caller wants both, for the player and for each opponent.
//
//   trajectory — the reconstruction % AFTER each guess. Starts from `freshHoles` (each at
//     its start_rank), monotonic non-decreasing, and the guess that solved the sentence
//     lands at 100. One value per guess, so `.length === guessCount`.
//   solvedAt — per DISTINCT secret in sentence order (first occurrence's pos), the 1-based
//     try that dropped it, or null when the run never does (a DNF opponent). Every
//     occurrence of a repeated secret solves on the same guess (they share one rank map),
//     so one distinct secret = one tick.
export interface RunReplay {
  trajectory: number[];
  solvedAt: (number | null)[];
}

export function replayRun(freshHoles: RuntimeHole[], ranks: RankMap, tried: string[]): RunReplay {
  const holes = freshHoles.map((h) => ({ ...h }));
  const secrets = holes.map((h) => h.secret).filter((s, i, a) => a.indexOf(s) === i);
  const trajectory: number[] = [];
  const solvedAt: (number | null)[] = secrets.map(() => null);
  tried.forEach((typed, i) => {
    for (const h of holes) {
      if (h.rank === 0) continue; // solved holes are locked, exactly as in-game
      const entry = ranks[h.secret]?.[typed];
      if (entry && entry.rank < h.rank) h.rank = entry.rank;
    }
    trajectory.push(computeProgress(holes, ranks));
    secrets.forEach((s, si) => {
      if (solvedAt[si] === null && holes.every((h) => h.secret !== s || h.rank === 0)) {
        solvedAt[si] = i + 1;
      }
    });
  });
  return { trajectory, solvedAt };
}

// The two halves on their own, for callers (and contract tests) that want just one.
export function progressTrajectory(
  freshHoles: RuntimeHole[],
  ranks: RankMap,
  tried: string[],
): number[] {
  return replayRun(freshHoles, ranks, tried).trajectory;
}

export function solveTicks(
  freshHoles: RuntimeHole[],
  ranks: RankMap,
  tried: string[],
): (number | null)[] {
  return replayRun(freshHoles, ranks, tried).solvedAt;
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
