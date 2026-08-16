// CONTRACT: the solved screen's STANDING (#170) over the backend's histogram (#169). The
// backend owns the bucket EDGES (this module only reads the inclusive ranges the API
// returned); the WEB owns the reading:
//   - a score is located in the inclusive ranges (the GET path sends `bucket: null`);
//   - RANK is competition ranking — everyone strictly ahead, plus one — so a whole band
//     shares its rank, which is the only honest number at bucket granularity;
//   - sentence is lower-is-better (ahead = FEWER tries), word is higher-is-better
//     (ahead = MORE claims);
//   - TOP uses the midpoint of the shared bucket, and only above PERCENT_MIN_TOTAL players;
//   - a finished round submits ONCE: only finished-and-not-yet-submitted rounds POST.

import { describe, it, expect } from 'vitest';
import type { ScoreHistogramBucket } from '@whippin/shared';
import {
  PERCENT_MIN_TOTAL,
  bucketIndexOf,
  formatTopPct,
  scoreStanding,
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

  it('returns null for a score no range holds — say nothing rather than lie', () => {
    expect(bucketIndexOf(buckets([0, 0, 0, 0]), 13)).toBeNull();
    expect(bucketIndexOf(buckets([0, 0, 0, 0]), 0)).toBeNull();
  });
});

describe('scoreStanding — rank is everyone strictly ahead, plus one', () => {
  // Population: 5 in the best sentence band, 3, 2, then 7 in the worst. 17 players.
  const b = buckets([5, 3, 2, 7]);

  it('sentence (tries, lower is better): the bands BEFORE mine are ahead', () => {
    expect(scoreStanding('sentence', b, 17, 0)?.rank).toBe(1);
    expect(scoreStanding('sentence', b, 17, 1)?.rank).toBe(6);
    expect(scoreStanding('sentence', b, 17, 3)?.rank).toBe(11);
  });

  it('word (claims, higher is better): the bands AFTER mine are ahead', () => {
    expect(scoreStanding('word', b, 17, 3)?.rank).toBe(1);
    expect(scoreStanding('word', b, 17, 2)?.rank).toBe(8);
    expect(scoreStanding('word', b, 17, 0)?.rank).toBe(13);
  });

  it('a whole band SHARES its rank — a tie is never broken by invention', () => {
    // Everyone in band 1 is 6th: the five ahead of them are ahead, the two beside them
    // are not behind.
    const mine = scoreStanding('sentence', b, 17, 1);
    expect(mine).toEqual({ rank: 6, total: 17, topPct: (100 * 6.5) / 17 });
  });

  it('the only player today is first of one', () => {
    expect(scoreStanding('sentence', buckets([1]), 1, 0)).toEqual({
      rank: 1,
      total: 1,
      topPct: null, // one player is not a field to be in the top of
    });
  });

  it('never ranks anyone past the population it is drawn from', () => {
    // A histogram whose counts outrun its own total (a stale read racing a write).
    expect(scoreStanding('sentence', buckets([9, 9, 9, 9]), 4, 3)?.rank).toBe(4);
  });

  it('says nothing at all when there is no band, or no population', () => {
    expect(scoreStanding('sentence', b, 17, null)).toBeNull();
    expect(scoreStanding('sentence', buckets([]), 0, 0)).toBeNull();
  });
});

describe('scoreStanding — the TOP percentage', () => {
  const big = (aheadCount: number, bucketCount: number, total: number) =>
    scoreStanding(
      'sentence',
      buckets([aheadCount, bucketCount, total - aheadCount - bucketCount]),
      total,
      1,
    );

  it('uses the midpoint of a shared bucket, independently of competition rank', () => {
    // 5 players are ahead and 20 share this bucket: everyone is ranked 6th, while the
    // bucket spans positions 6 through 25 and its percentile-rank midpoint is TOP 25%.
    const standing = big(5, 20, 60);
    expect(standing?.rank).toBe(6);
    expect(standing?.topPct).toBe(25);
  });

  it('puts an all-tied field at TOP 50%', () => {
    const standing = scoreStanding('sentence', buckets([60]), 60, 0);
    expect(standing?.rank).toBe(1);
    expect(standing?.topPct).toBe(50);
  });

  it('needs MORE than PERCENT_MIN_TOTAL players, or it is arithmetic on a handful', () => {
    expect(big(0, 1, 1)?.topPct).toBeNull();
    expect(big(1, 1, 3)?.topPct).toBeNull();
    expect(big(4, 1, PERCENT_MIN_TOTAL)?.topPct).toBeNull();
  });

  it('starts at the midpoint of the first eligible single-player bucket', () => {
    const standing = big(4, 1, PERCENT_MIN_TOTAL + 1);
    expect(standing?.rank).toBe(5);
    expect(standing?.topPct).toBeCloseTo((100 * 4.5) / (PERCENT_MIN_TOTAL + 1), 10);
  });

  it('a single-player bucket uses the same midpoint rule', () => {
    const standing = big(4, 1, 59);
    expect(standing?.rank).toBe(5);
    expect(formatTopPct(standing!.topPct!)).toBe('7.63');
  });

  it('does not badge an empty hypothetical bucket', () => {
    const standing = big(4, 0, 59);
    expect(standing?.rank).toBe(5);
    expect(standing?.topPct).toBeNull();
  });

  it('never prints above TOP 100% for an inconsistent stale snapshot', () => {
    const standing = scoreStanding('sentence', buckets([9, 9, 9, 9]), 11, 3);
    expect(standing?.topPct).toBe(100);
  });
});

describe('formatTopPct — at most two decimals, no machine zeros', () => {
  it('keeps the digits that carry the claim', () => {
    expect(formatTopPct((100 * 5) / 59)).toBe('8.47');
    expect(formatTopPct(12.5)).toBe('12.5');
  });

  it('strips trailing zeros rather than printing 50.00', () => {
    expect(formatTopPct(50)).toBe('50');
    expect(formatTopPct(100)).toBe('100');
    expect(formatTopPct(12.501)).toBe('12.5');
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
