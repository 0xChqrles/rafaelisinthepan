// CONTRACT: the solved screen's percentile reading (#170) over the backend's histogram
// (#169). The backend owns the bucket EDGES (this module only reads the inclusive ranges
// the API returned); the WEB owns the reading — which bucket is the player's, which
// direction is "worse" per mode, and which copy an N-sized population has earned:
//   - low N stays count-based and honest ("first player today", "you and 4 others");
//   - only PERCENT_MIN_TOTAL (a couple dozen) recorded scores earn "you beat x%";
//   - sentence is lower-is-better (worse = MORE tries), word is higher-is-better
//     (worse = FEWER claims); ties in the player's own bucket are never claimed beaten;
//   - a finished round submits ONCE: only finished-and-not-yet-submitted rounds POST.

import { describe, it, expect } from 'vitest';
import type { ScoreHistogramBucket } from '@whippin/shared';
import {
  MAX_CHART_BANDS,
  MAX_COLUMN_UNITS,
  PERCENT_MIN_TOTAL,
  beatenCount,
  bucketIndexOf,
  chartField,
  chartUnits,
  histogramCopy,
  shouldSubmitScore,
} from './scores';

// Four ascending bands in the API's shape; counts chosen per test.
function buckets(counts: number[]): ScoreHistogramBucket[] {
  const edges = [
    { min: 1, max: 3 },
    { min: 4, max: 5 },
    { min: 6, max: 8 },
    { min: 9, max: 12 },
  ];
  return edges.map((range, i) => ({ ...range, count: counts[i] ?? 0 }));
}

describe('bucketIndexOf', () => {
  it('locates a score in the inclusive ranges (the GET path, where the API sends bucket: null)', () => {
    const b = buckets([0, 0, 0, 0]);
    expect(bucketIndexOf(b, 1)).toBe(0);
    expect(bucketIndexOf(b, 3)).toBe(0);
    expect(bucketIndexOf(b, 4)).toBe(1);
    expect(bucketIndexOf(b, 12)).toBe(3);
  });

  it('returns null for a score no range holds — highlight nothing rather than lie', () => {
    expect(bucketIndexOf(buckets([0, 0, 0, 0]), 13)).toBeNull();
    expect(bucketIndexOf(buckets([0, 0, 0, 0]), 0)).toBeNull();
  });
});

describe('beatenCount — which direction is worse', () => {
  // Population: 5 in the best sentence band, 3 mid, 2 mid, 7 in the worst.
  const b = buckets([5, 3, 2, 7]);

  it('sentence (tries, lower is better): worse = the buckets AFTER mine', () => {
    expect(beatenCount('sentence', b, 1)).toBe(2 + 7);
    expect(beatenCount('sentence', b, 0)).toBe(3 + 2 + 7);
    expect(beatenCount('sentence', b, 3)).toBe(0);
  });

  it('word (claims, higher is better): worse = the buckets BEFORE mine', () => {
    expect(beatenCount('word', b, 1)).toBe(5);
    expect(beatenCount('word', b, 3)).toBe(5 + 3 + 2);
    expect(beatenCount('word', b, 0)).toBe(0);
  });

  it('never claims the player’s own bucket — ties are not beaten', () => {
    expect(beatenCount('sentence', b, 1) + beatenCount('word', b, 1)).toBe(2 + 7 + 5);
  });
});

describe('histogramCopy — what N has earned', () => {
  it('total 0 or 1 → "first player today" (the empty chart IS the come-back-later message)', () => {
    expect(histogramCopy('sentence', buckets([1, 0, 0, 0]), 1, 0)).toEqual({ kind: 'first' });
    expect(histogramCopy('word', buckets([0, 0, 0, 0]), 0, 2)).toEqual({ kind: 'first' });
  });

  it('below PERCENT_MIN_TOTAL → honest count of the others', () => {
    expect(histogramCopy('sentence', buckets([2, 0, 0, 0]), 2, 0)).toEqual({
      kind: 'others',
      others: 1,
    });
    const total = PERCENT_MIN_TOTAL - 1;
    expect(histogramCopy('sentence', buckets([total, 0, 0, 0]), total, 0)).toEqual({
      kind: 'others',
      others: total - 1,
    });
  });

  it('at PERCENT_MIN_TOTAL and above → the percentile claim, over the OTHER players', () => {
    // 25 recorded scores: me in the best band with 4 ties, 20 strictly worse.
    const b = buckets([5, 20, 0, 0]);
    expect(histogramCopy('sentence', b, 25, 0)).toEqual({
      kind: 'percent',
      pct: Math.round((100 * 20) / 24),
    });
    // Word flips the direction: same shape, me in the second band beats the first's 5.
    expect(histogramCopy('word', b, 25, 1)).toEqual({
      kind: 'percent',
      pct: Math.round((100 * 5) / 24),
    });
  });

  it('falls back to the honest count when the player’s bucket is unknown', () => {
    const b = buckets([30, 0, 0, 0]);
    expect(histogramCopy('sentence', b, 30, null)).toEqual({ kind: 'others', others: 29 });
  });
});

describe('shouldSubmitScore — the submit-once guard', () => {
  it('only a finished, not-yet-submitted round POSTs', () => {
    expect(shouldSubmitScore(true, false)).toBe(true);
  });

  it('an unfinished round never submits; a submitted round never re-submits', () => {
    expect(shouldSubmitScore(false, false)).toBe(false);
    expect(shouldSubmitScore(true, true)).toBe(false);
    expect(shouldSubmitScore(false, true)).toBe(false);
  });
});

// CONTRACT (#170, 2026-08-15): what the chart DRAWS. The API's bands run to the mode's
// absolute ceiling, so the unreachable tail is merged into ONE final column labelled with
// the last individually drawn band's max. Counts are only ever summed — never re-cut — and
// the two legend labels are read off the bands themselves, never restated.
describe('chartField — the drawn field and its two named ends', () => {
  // The real sentence shape: 15 bands, the last three unreachable in practice.
  const sentence = [3, 5, 8, 12, 18, 25, 40, 60, 100, 200, 500, 1_000, 5_000, 20_000, 127_783];
  const band = (maxes: number[], counts: number[] = []) => {
    let min = 1;
    return maxes.map((max, i) => {
      const range = { min, max, count: counts[i] ?? 0 };
      min = max + 1;
      return range;
    });
  };

  it('merges the tail into one column and names the ends "3" and "+100"', () => {
    const field = chartField(band(sentence), 0);
    expect(field.counts).toHaveLength(MAX_CHART_BANDS);
    expect(field.low).toBe('3');
    expect(field.high).toBe('+100');
  });

  it('the merged column is the SUM of every band it swallowed — nothing is dropped', () => {
    const counts = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    const field = chartField(band(sentence, counts), 0);
    const tail = counts.slice(MAX_CHART_BANDS - 1).reduce((a, b) => a + b, 0);
    expect(field.counts[MAX_CHART_BANDS - 1]).toBe(tail);
    expect(field.counts.reduce((a, b) => a + b, 0)).toBe(counts.reduce((a, b) => a + b, 0));
  });

  it('a score anywhere in the tail lands on the column that now stands for it', () => {
    expect(chartField(band(sentence), 12).you).toBe(MAX_CHART_BANDS - 1);
    expect(chartField(band(sentence), 14).you).toBe(MAX_CHART_BANDS - 1);
    // A band drawn in its own right keeps its own column.
    expect(chartField(band(sentence), 4).you).toBe(4);
    expect(chartField(band(sentence), null).you).toBeNull();
  });

  it('a field that already fits is drawn as-is, with no "+" on its end', () => {
    const short = band([3, 5, 8], [1, 2, 3]);
    const field = chartField(short, 1);
    expect(field.counts).toEqual([1, 2, 3]);
    expect(field.you).toBe(1);
    expect(field.low).toBe('3');
    expect(field.high).toBe('8');
  });
});

// CONTRACT (#170, 2026-08-15): the FIELD IS ALWAYS THE SAME HEIGHT. Counts are normalized
// against the field's own peak, so the tallest column reaches the top whatever the data —
// four scores and four hundred draw the same shape — and the degenerate cases (one entry,
// or none at all) give that single bar its full height rather than leaving a flat field.
describe('chartUnits — the field is always the same height', () => {
  const tallest = (u: number[]) => Math.max(...u);

  it('the tallest column reaches the top, for any data', () => {
    const fields: number[][] = [
      [3],
      [1, 1, 1],
      [0, 0, 7, 0],
      [2, 9, 21, 34, 27, 15, 8, 4, 2, 1],
      [500, 1, 1],
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 999],
    ];
    for (const counts of fields) {
      expect(tallest(chartUnits(counts, null))).toBe(MAX_COLUMN_UNITS);
      expect(tallest(chartUnits(counts, 0))).toBe(MAX_COLUMN_UNITS);
    }
  });

  it('ONE entry is the peak by definition, so its bar is full height', () => {
    expect(chartUnits([0, 0, 1, 0], 2)).toEqual([0, 0, MAX_COLUMN_UNITS, 0]);
    // …whoever it belongs to.
    expect(chartUnits([0, 0, 1, 0], 0)).toEqual([1, 0, MAX_COLUMN_UNITS, 0]);
  });

  it('NO entries at all: the player’s marker is the field’s only entry, at full height', () => {
    expect(chartUnits([0, 0, 0, 0], 1)).toEqual([0, MAX_COLUMN_UNITS, 0, 0]);
  });

  it('every non-empty band draws at least one brick, however small its share', () => {
    const units = chartUnits([1000, 1, 0], null);
    expect(units[0]).toBe(MAX_COLUMN_UNITS);
    expect(units[1]).toBe(1);
    expect(units[2]).toBe(0);
  });

  it('the player’s marker never inflates above what the population says', () => {
    // A real crowd this player is not recorded in: one brick — visible, never a claim.
    expect(chartUnits([40, 0, 5], 1)).toEqual([MAX_COLUMN_UNITS, 1, 1]);
  });

  it('no column is ever taller than the field', () => {
    for (const counts of [[1, 2, 3], [0, 0, 0], [9, 9, 9, 9]]) {
      for (const u of chartUnits(counts, 0)) expect(u).toBeLessThanOrEqual(MAX_COLUMN_UNITS);
    }
  });
});
