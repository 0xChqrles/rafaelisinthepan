// CONTRACT: the solved screen's STANDING (#170) over the backend's histogram (#169). The
// backend owns the bucket EDGES (this module only reads the inclusive ranges the API
// returned); the WEB owns the reading:
//   - RANK is competition ranking — everyone strictly ahead, plus one — so a whole band
//     shares its rank, which is the only honest number at bucket granularity;
//   - sentence is lower-is-better (ahead = FEWER tries), word is higher-is-better
//     (ahead = MORE claims);
//   - TOP uses the midpoint of the shared bucket, and only above PERCENT_MIN_TOTAL players,
//     from PERCENT_MIN_RANK on (a single-digit rank has already said it) AND above the
//     median (PERCENT_MAX — a badge reading TOP 99% is the word TOP turned against the
//     player wearing it);
// `shouldSubmitScore`/`shouldAskPopulation` are GONE (#203): there is no submission left
// to gate — the server derives the score from the log it stores and records the row itself,
// so a finished round only ever READS, and only once the server says it holds it.

import { describe, it, expect } from 'vitest';
import type { ScoreHistogramBucket } from '@whippin/shared';
import {
  PERCENT_MAX,
  PERCENT_MIN_RANK,
  PERCENT_MIN_TOTAL,
  formatTopPct,
  scoreStanding,
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
    // are not behind. (No percentage beside it: a single-digit rank has already said it.)
    const mine = scoreStanding('sentence', b, 17, 1);
    expect(mine).toEqual({ rank: 6, total: 17, topPct: null });
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
    // 15 players are ahead and 20 share this bucket: everyone is ranked 16th, while the
    // bucket spans positions 16 through 35 and its percentile-rank midpoint is TOP 25%.
    const standing = big(15, 20, 100);
    expect(standing?.rank).toBe(16);
    expect(standing?.topPct).toBe(25);
  });

  it('a single-player bucket uses the same midpoint rule', () => {
    const standing = big(14, 1, 59);
    expect(standing?.rank).toBe(15);
    expect(formatTopPct(standing!.topPct!)).toBe('24.6'); // 100 * 14.5 / 59
  });

  it('says nothing beside a SINGLE-DIGIT rank — that rank has already said it', () => {
    // One band apart in the same field: 9th carries no percentage, 10th does.
    const ninth = big(PERCENT_MIN_RANK - 2, 20, 100);
    expect(ninth?.rank).toBe(PERCENT_MIN_RANK - 1);
    expect(ninth?.topPct).toBeNull();

    const tenth = big(PERCENT_MIN_RANK - 1, 20, 100);
    expect(tenth?.rank).toBe(PERCENT_MIN_RANK);
    expect(tenth?.topPct).toBe(19); // 100 * (9 + 10) / 100
  });

  it('an all-tied field is FIRST of its own count, and says nothing more', () => {
    // The midpoint would be 50%, but everyone in an all-tied field ranks 1st, so the
    // percentage is gated by the rank before it can be claimed.
    const standing = scoreStanding('sentence', buckets([60]), 60, 0);
    expect(standing?.rank).toBe(1);
    expect(standing?.topPct).toBeNull();
  });

  it('needs MORE than PERCENT_MIN_TOTAL players, or it is arithmetic on a handful', () => {
    // Ranked 10th in a field of exactly 10: past the RANK floor, still short of the
    // population one, which is why the two are separate gates.
    const short = scoreStanding('sentence', buckets([9, 1]), PERCENT_MIN_TOTAL, 1);
    expect(short?.rank).toBe(PERCENT_MIN_RANK);
    expect(short?.topPct).toBeNull();

    // The three gates overlap: a rank of 10 already puts nine players ahead, so the
    // SMALLEST field that can still reach the median is 19 — one player more than
    // PERCENT_MIN_TOTAL is nowhere near enough any more. The floor stays because it
    // states its own claim, not because it is the last one standing.
    const smallest = scoreStanding('sentence', buckets([9, 1, 9]), 19, 1);
    expect(smallest?.rank).toBe(PERCENT_MIN_RANK);
    expect(smallest?.topPct).toBe(PERCENT_MAX);
  });

  it('does not badge an empty hypothetical bucket', () => {
    const standing = big(14, 0, 59);
    expect(standing?.rank).toBe(15);
    expect(standing?.topPct).toBeNull();
  });

  it('says nothing for an inconsistent stale snapshot, which lands at the bottom', () => {
    // A histogram whose counts outrun its own total puts the player last of the field it
    // reports, which is the far side of the median and no claim at all.
    const standing = scoreStanding('sentence', buckets([9, 9, 9, 9]), 11, 3);
    expect(standing?.rank).toBe(11);
    expect(standing?.topPct).toBeNull();
  });
});

describe('scoreStanding — the badge only speaks ABOVE THE MEDIAN', () => {
  it('says nothing to the last player of the day — the case it backfired on', () => {
    // `RANK #60 OF 60` beside `TOP 99.17%` set the word TOP against the one standing it
    // cannot flatter. The rank line alone is what that player reads now.
    const standing = scoreStanding('sentence', buckets([59, 1]), 60, 1);
    expect(standing?.rank).toBe(60);
    expect(standing?.topPct).toBeNull();
  });

  it('badges the median itself, and nothing past it', () => {
    // 40 players, 9 ahead and 22 sharing the band: rank 10, midpoint exactly 20 of 40.
    const median = scoreStanding('sentence', buckets([9, 22, 9]), 40, 1);
    expect(median?.rank).toBe(PERCENT_MIN_RANK);
    expect(median?.topPct).toBe(PERCENT_MAX);

    // Four more in the band and the same rank sits at 22 of 40 — past the median.
    const under = scoreStanding('sentence', buckets([9, 26, 5]), 40, 1);
    expect(under?.rank).toBe(PERCENT_MIN_RANK);
    expect(under?.topPct).toBeNull();
  });

  it('splits on the percentage, not the rank: 50 speaks and 51 does not', () => {
    const fifty = scoreStanding('sentence', buckets([40, 20, 40]), 100, 1);
    expect(fifty?.rank).toBe(41);
    expect(fifty?.topPct).toBe(50);

    const fiftyOne = scoreStanding('sentence', buckets([41, 20, 39]), 100, 1);
    expect(fiftyOne?.rank).toBe(42);
    expect(fiftyOne?.topPct).toBeNull();
  });

  it('reads the WORD direction the same way — ahead is the bands after mine', () => {
    // The same two fields, with the nine players ahead put where claims count them:
    // in the bands AFTER the player's. Band 0 holds the rest, behind.
    const median = scoreStanding('word', buckets([9, 22, 9, 0]), 40, 1);
    expect(median?.rank).toBe(PERCENT_MIN_RANK);
    expect(median?.topPct).toBe(PERCENT_MAX);

    const under = scoreStanding('word', buckets([5, 26, 9, 0]), 40, 1);
    expect(under?.rank).toBe(PERCENT_MIN_RANK);
    expect(under?.topPct).toBeNull();
  });
});

describe('formatTopPct — at most ONE decimal, no machine zeros', () => {
  it('keeps the one digit that carries the claim, and drops the rest', () => {
    expect(formatTopPct((100 * 5) / 59)).toBe('8.5'); // 8.4745…
    expect(formatTopPct(12.5)).toBe('12.5');
    expect(formatTopPct(20.34)).toBe('20.3');
  });

  it('strips the trailing zero rather than printing 50.0', () => {
    expect(formatTopPct(50)).toBe('50');
    expect(formatTopPct(100)).toBe('100');
    expect(formatTopPct(12.501)).toBe('12.5');
  });
});
