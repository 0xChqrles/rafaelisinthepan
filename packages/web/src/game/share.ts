// Solved-screen share text (issue #8): a Wordle-style, spoiler-free emoji grid.
//
// The grid has ONE line per counted guess (a submitted word that exists in the vocab
// Set — the same definition as the score), showing the reconstruction % reached AFTER
// that guess. The words themselves never appear, so a shared result gives nothing away.

import { computeProgress } from './scoring';
import type { RankMap, RuntimeHole } from '@whippin/shared';

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

// Three heat buckets (upper bounds 33 / 67 / 100) colored to match the heat ramp
// (game/heat.ts): cold crimson -> hot cyan. A low % is far from the goal (🟥); a solved
// sentence is hot (🟦). Boundary rule: pct <= max, so 33 -> 🟥, 67 -> 🟪, 100 -> 🟦.
const SHARE_BUCKETS: { max: number; emoji: string }[] = [
  { max: 33, emoji: '🟥' }, // cold: far
  { max: 67, emoji: '🟪' }, // warm: halfway
  { max: 100, emoji: '🟦' }, // hot: solved
];

export function shareEmoji(pct: number): string {
  const bucket = SHARE_BUCKETS.find((b) => pct <= b.max);
  return (bucket ?? SHARE_BUCKETS[SHARE_BUCKETS.length - 1]).emoji;
}

export interface ShareParams {
  dayNumber: number | null; // omitted from the header for a ?puzzle= override (no day)
  guessCount: number;
  trajectory: number[]; // reconstruction % after each counted guess
  url?: string; // optional link appended last (the site origin)
}

// The full shareable text: a header (title + day + score), a blank line, the emoji grid
// (one line per guess), and — when given — the site URL. No words, so no spoilers.
export function buildShareText({ dayNumber, guessCount, trajectory, url }: ShareParams): string {
  const title = dayNumber != null ? `Whippin AI #${dayNumber}` : 'Whippin AI';
  const header = `${title} — SCORE ${guessCount}`;
  const grid = trajectory.map((pct) => `${shareEmoji(pct)} ${Math.round(pct)}%`).join('\n');
  const parts = [header, grid];
  if (url) parts.push(url);
  return parts.join('\n\n');
}
