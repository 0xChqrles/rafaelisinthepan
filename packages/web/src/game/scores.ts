// The solved screen's STANDING (#170): where a finished round's score sits in the day's
// anonymous population (#169). The BACKEND owns the bands — since #187 it derives them
// from the day's per-player rows at read time (one exact inclusive range per distinct
// recorded score) — so everything here reads the inclusive
// ranges the API returned rather than restating them. What the WEB owns is the reading:
// which bucket is the player's, how many players are strictly ahead of them, where the
// midpoint of their shared bucket sits, and whether the population is big enough for a
// percentage to mean anything.

import type { ScoreHistogramBucket } from '@whippin/shared';
import type { Mode } from '../langs';

// A TOP percentage needs a real field behind it: above this many recorded scores it is a
// standing, at or below it is arithmetic on a handful of people ("TOP 33.33%" of three
// players says nothing the rank did not already say). Reinstated at 10 (user-decided
// 2026-08-15) after a day without a floor at all — the line still always states the rank
// out of the count, which is true at every size, so what the threshold gates is only the
// CLAIM the badge makes.
export const PERCENT_MIN_TOTAL = 10;

// And a percentage needs a rank that does NOT already answer the question (user-decided
// 2026-08-17). `RANK #6 OF 60` names an exact position a reader takes in at a glance; a
// percentage beside it restates in blur what the number just said outright. From two digits
// on, the rank stops being that legible — `#37 OF 412` is a position you have to place —
// and the percentage is what carries the standing. So the badge starts at rank 10.
export const PERCENT_MIN_RANK = 10;

// Locate a score in the API's inclusive ranges — the GET path, where the server returns
// `bucket: null` because a revisiting client already knows its persisted score. Null for
// a score no range holds (a malformed histogram, or a local score the population never
// recorded, #187): the standing then simply isn't drawn rather than lying.
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
  // Standard percentile-rank treatment for a tie: `(strictly ahead + half the shared
  // bucket) / total`, as a percentage. NULL when the bucket is empty, when the population
  // is at or below `PERCENT_MIN_TOTAL` and a percentage would be false precision, or when
  // the rank is a single digit and has already said it (`PERCENT_MIN_RANK`).
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
  const aheadCount = ahead.reduce((n, b) => n + b.count, 0);
  const bucketCount = buckets[bucket]?.count ?? 0;
  const rank = Math.min(total, aheadCount + 1);
  const midpoint = Math.min(total, aheadCount + bucketCount / 2);
  // The two floors overlap (a rank of 10 already implies nine players ahead) but they gate
  // different claims: one asks whether there is a field, the other whether the percentage
  // adds anything to the rank beside it.
  const topPct =
    total > PERCENT_MIN_TOTAL && rank >= PERCENT_MIN_RANK && bucketCount > 0
      ? (100 * midpoint) / total
      : null;
  return { rank, total, topPct };
}

// The TOP percentage as the badge prints it: at most ONE decimal, and no trailing zero —
// `8.5`, `12.5`, `50` (user-decided 2026-08-17, from two decimals). A decimal because on a
// real population the first one still carries a claim ("TOP 8" and "TOP 8.5" are different
// standings); only one because the second is precision nobody reads, and stripping the
// zero because `50.0` reads as a machine talking.
export function formatTopPct(pct: number): string {
  return String(Math.round(pct * 10) / 10);
}

// `shouldSubmitScore` / `shouldAskPopulation` are GONE (#203). They decided which half of
// a POST-or-GET round trip ran, and whether a #201 capped round was still allowed to claim
// a place. There is no submission left to gate: the server derives the score from the log
// it stores and writes the row itself, so a finished round only ever READS — and it reads
// exactly when the server says it holds the round (`RoundProgress.recorded`, the word
// round's `submitted`). The cap needs no rule of its own either: a capped round's appends
// were refused, so its solve never reached the server and no row exists to find.

// The standing is FIXED-WIDTH TYPE — the pixel font does not reflow, and `body` is
// `overflow: hidden`, so a line that outruns its column is CUT OFF rather than scrolled to.
// A phone column holds the tuned sizes comfortably for a short standing and lands exactly
// on the edge for a long one (`RANG #12 SUR 59  TOP 20.34%` measures 362px against the
// 362px a 390px screen leaves), so the line asks for its own step down by LENGTH, in
// addition to the width tiers in the CSS. That measurement calibrates UNITS to pixels and
// so outlives the badge it was taken on: the one-decimal percentage is a glyph shorter,
// which only means the same 26 units are now reached by a longer population
// (`RANG #12 SUR 599  TOP 20.3%`).
//
// The estimate is in LABEL GLYPHS: every character of the small type counts one, and the
// rank number counts DOUBLE — the whole line is the PIXEL face since 2026-08-18 (labels,
// number and badge alike), so one unit is one label glyph at the pixel's 1em advance and
// the rank digits weigh rank-size/label-size ≈ 2. That is all the precision this needs —
// the face is monospace, so a glyph count IS a width.
export const TIGHT_STANDING_UNITS = 26;

export function standingUnits(rankLabel: string, ofLabel: string, rank: number, topLabel: string): number {
  return rankLabel.length + ofLabel.length + topLabel.length + 2 * (String(rank).length + 1);
}
