// The solved screen's percentile story (#170): where a finished round's score sits in the
// day's anonymous population (#169). The BACKEND owns the bucket edges — changing one
// changes which DynamoDB counter a submission lands in — so everything here reads the
// inclusive ranges the API returned rather than restating them. What the WEB owns is the
// reading: which bucket is the player's, how many players did worse, and which copy an
// N-sized population has earned.

import type { ScoreHistogramBucket } from '@whippin/shared';
import type { Mode } from '../langs';

// Above this many recorded scores the copy switches from honest counts ("you and 4
// others") to the percentile claim ("you beat 82%") — a percentage over a handful of
// players is false precision. "A couple dozen" per the issue.
export const PERCENT_MIN_TOTAL = 25;

// Locate a score in the API's inclusive ranges — the GET path, where the server returns
// `bucket: null` because a revisiting client already knows its persisted score. Null for
// a score no range holds (a malformed histogram, or a stale score after an edge retune):
// the chart then simply highlights nothing rather than lying.
export function bucketIndexOf(buckets: readonly ScoreHistogramBucket[], score: number): number | null {
  const index = buckets.findIndex(({ min, max }) => score >= min && score <= max);
  return index < 0 ? null : index;
}

// How many recorded players this score BEAT: the summed counts of every strictly-worse
// bucket. The buckets ascend by score in both modes, but the modes disagree on which way
// is worse — sentence counts tries (lower is better, worse = the buckets after mine),
// word counts claims (higher is better, worse = the buckets before mine). Ties in the
// player's own bucket are never claimed as beaten.
export function beatenCount(
  mode: Mode,
  buckets: readonly ScoreHistogramBucket[],
  bucket: number,
): number {
  const worse =
    mode === 'word' ? buckets.slice(0, bucket) : buckets.slice(bucket + 1);
  return worse.reduce((n, b) => n + b.count, 0);
}

// The one line under the chart, adapted to N (`total` counts every recorded score, the
// player's included). Low N stays count-based and honest; only a real population earns
// the percentile. The chart itself renders at ANY N — an empty field with your bucket
// marked IS the "you've just been early" message — so this never gates rendering.
export type HistogramCopy =
  | { kind: 'first' }
  | { kind: 'others'; others: number }
  | { kind: 'percent'; pct: number };

export function histogramCopy(
  mode: Mode,
  buckets: readonly ScoreHistogramBucket[],
  total: number,
  bucket: number | null,
): HistogramCopy {
  if (total <= 1) return { kind: 'first' };
  if (total < PERCENT_MIN_TOTAL || bucket === null) {
    return { kind: 'others', others: total - 1 };
  }
  // Beaten over the OTHER players (the player cannot beat themselves); total >= 25 here,
  // so the denominator is never zero.
  const pct = Math.round((100 * beatenCount(mode, buckets, bucket)) / (total - 1));
  return { kind: 'percent', pct };
}

// Whether a finished round still owes the population its score. The flag persists with
// the round (#7/#9's pattern), so a reload or a revisit can never re-submit — and a round
// finished offline (or a Word run whose clock died with the tab closed) submits the first
// time its result is actually seen.
export function shouldSubmitScore(finished: boolean, submitted: boolean): boolean {
  return finished && !submitted;
}

// ---- what the CHART actually draws (user-decided 2026-08-15) --------------------------
// The API's bands run to the mode's absolute ceiling — a sentence's last three cover
// 1001..127783, which no player will ever occupy — so drawing one column each spent half
// the field on bands that are permanently empty and left the right end labelled with a
// number that means nothing. The web therefore MERGES the tail into one final band and
// labels it `+<the last individually drawn band's max>`.
//
// This is a rendering choice, not a restating of the edges: every count still comes from
// the ranges the API returned (the backend owns them), and merging only ever ADDS counts
// together. Nothing here knows a bucket boundary — the labels are read off the bands.
export const MAX_CHART_BANDS = 10;

export interface ChartField {
  // Counts to draw, left to right; the last one may be a merged tail.
  counts: number[];
  // The player's drawn column (their band, or the merged tail that swallowed it).
  you: number | null;
  // The two ends, named: the best band's own ceiling, and `+N` when a tail was merged.
  low: string;
  high: string;
}

export function chartField(
  buckets: readonly ScoreHistogramBucket[],
  bucket: number | null,
): ChartField {
  const low = String(buckets[0]?.max ?? 0);
  if (buckets.length <= MAX_CHART_BANDS) {
    return {
      counts: buckets.map((b) => b.count),
      you: bucket,
      low,
      high: String(buckets[buckets.length - 1]?.max ?? 0),
    };
  }
  const drawn = buckets.slice(0, MAX_CHART_BANDS - 1);
  const tail = buckets.slice(MAX_CHART_BANDS - 1);
  return {
    counts: [...drawn.map((b) => b.count), tail.reduce((n, b) => n + b.count, 0)],
    // A score anywhere in the tail lands on the one column that now stands for it.
    you: bucket === null ? null : Math.min(bucket, MAX_CHART_BANDS - 1),
    low,
    high: `+${drawn[drawn.length - 1].max}`,
  };
}

// ---- how TALL each drawn column is (user-decided 2026-08-15) --------------------------
// A column is a stack of whole bricks, and the FIELD IS ALWAYS THE SAME HEIGHT: whatever
// the data, the tallest column reaches the top. So the counts are normalized against the
// field's own peak rather than against any absolute number of players — a day with four
// scores and a day with four hundred draw the same shape, which is what makes the shape
// readable at all.
//
// The two degenerate cases are what that rule is FOR:
//   - one entry — it is the peak by definition, so it draws FULL height;
//   - no entries at all (your submission was refused, or a GET landed before your own
//     write) — the player's marker is then the field's only entry, and gets the same
//     full-height treatment rather than sitting one brick off the floor.
// Anywhere else the player's marker is a MARKER and not a tally: it draws at least one
// real brick so "your score sits here" is always legible, but it never inflates itself
// above what the population says.
export const MAX_COLUMN_UNITS = 6;

export function chartUnits(counts: readonly number[], you: number | null): number[] {
  const peak = Math.max(0, ...counts);
  return counts.map((count, index) => {
    const mine = index === you;
    if (peak === 0) return mine ? MAX_COLUMN_UNITS : 0;
    if (count <= 0) return mine ? 1 : 0;
    return Math.max(1, Math.ceil((count / peak) * MAX_COLUMN_UNITS));
  });
}
