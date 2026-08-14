// The solved screen's STANDING (#170): where a finished round's score sits in the day's
// anonymous population (#169). The BACKEND owns the bucket edges — changing one changes
// which DynamoDB counter a submission increments — so everything here reads the inclusive
// ranges the API returned rather than restating them. What the WEB owns is the reading:
// which bucket is the player's, how many players are strictly ahead of them, and whether
// the population is big enough for a percentage to mean anything.

import type { ScoreHistogramBucket } from '@whippin/shared';
import type { Mode } from '../langs';

// Below this many recorded scores there is no TOP percentage: over a handful of players a
// percentage is false precision ("TOP 33.33%" of three people says nothing), and the rank
// out of the count already says everything true. "A couple dozen" per the issue.
export const PERCENT_MIN_TOTAL = 25;

// Locate a score in the API's inclusive ranges — the GET path, where the server returns
// `bucket: null` because a revisiting client already knows its persisted score. Null for
// a score no range holds (a malformed histogram, or a stale score after an edge retune):
// the standing then simply isn't drawn rather than lying.
export function bucketIndexOf(buckets: readonly ScoreHistogramBucket[], score: number): number | null {
  const index = buckets.findIndex(({ min, max }) => score >= min && score <= max);
  return index < 0 ? null : index;
}

// Where the player stands (user-decided 2026-08-15, replacing the population histogram —
// "the histogram is actually ugly": a bar field asks to be decoded, where a rank is the
// answer already given).
export interface ScoreStanding {
  // COMPETITION RANKING: everyone strictly ahead, plus one — so everybody sharing the
  // player's band shares its rank. That is the only honest number available at bucket
  // granularity (the API reports bands, never an order within one), and it is the
  // convention every scoreboard already uses for a tie.
  rank: number;
  // Recorded scores today, the player's own included.
  total: number;
  // `rank / total` as a percentage, or null when the population is too small for one to
  // mean anything (see PERCENT_MIN_TOTAL).
  topPct: number | null;
}

export function scoreStanding(
  mode: Mode,
  buckets: readonly ScoreHistogramBucket[],
  total: number,
  bucket: number | null,
): ScoreStanding | null {
  // Nothing honest to say: no band to stand in, or a population this score is not in.
  if (bucket === null || total < 1) return null;
  // The buckets ascend by score in both modes, but the modes disagree on which way is
  // better — sentence counts tries (lower is better, so the bands BEFORE mine are ahead),
  // word counts claims (higher is better, so the bands AFTER mine are).
  const ahead = mode === 'word' ? buckets.slice(bucket + 1) : buckets.slice(0, bucket);
  const rank = Math.min(total, ahead.reduce((n, b) => n + b.count, 0) + 1);
  return { rank, total, topPct: total >= PERCENT_MIN_TOTAL ? (100 * rank) / total : null };
}

// The TOP percentage as the badge prints it: at most two decimals, and no trailing zeros —
// `8.47`, `12.5`, `50`. Two decimals because on a real population the leading digits are
// the whole story ("TOP 8" and "TOP 8.47" are different claims), and stripping the zeros
// because `50.00` reads as a machine talking.
export function formatTopPct(pct: number): string {
  return String(Math.round(pct * 100) / 100);
}

// Whether a finished round still owes the population its score. The flag persists with
// the round (#7/#9's pattern), so a reload or a revisit can never re-submit — and a round
// finished offline (or a Word run whose clock died with the tab closed) submits the first
// time its result is actually seen.
export function shouldSubmitScore(finished: boolean, submitted: boolean): boolean {
  return finished && !submitted;
}
