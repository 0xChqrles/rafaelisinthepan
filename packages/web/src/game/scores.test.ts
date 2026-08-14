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
  PERCENT_MIN_TOTAL,
  beatenCount,
  bucketIndexOf,
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
