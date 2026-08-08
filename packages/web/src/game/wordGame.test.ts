// CONTRACT (#156 Word mode, retimed by #163 — decided 2026-08-08):
//   - score = number of top-zone (CLAIM_ZONE = the #154 road zone, 250) groups claimed;
//   - a claim also ADDS SECONDS to the clock, scaled by the claimed group's corpus
//     rarity (`freq`): a flat CLAIM_BASE_SECONDS plus its RARITY_TIERS extra. Rarity
//     feeds the CLOCK only, never the score — one resource, one number;
//   - a near miss (ranked, outside the zone) and a miss (off-map) add nothing and cost
//     nothing but the time spent typing. Nothing ends a run except the DEADLINE, which
//     this module deliberately does not know: `replayWordRun` reports no `ended`;
//   - free (no claim, no bonus): repeats — deduped at GROUP level (#104: inflections/
//     aliases of a tried group are a repeat) — and the day's word itself (it is public).
// Every number below is DERIVED from the tuning knobs, never typed out, so retuning the
// economy stays the one-line change the module promises.
// Asserted against the spec, not the implementation.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type { WordRanks } from '@whippin/shared';
import {
  CLAIM_BASE_SECONDS,
  CLAIM_ZONE,
  RARITY_TIERS,
  START_SECONDS,
  bonusSeconds,
  judgeWordGuess,
  replayWordRun,
  runMs,
  wordGuessKey,
} from './wordGame';

// The commonest and the rarest tier of the ladder, by their own declaration.
const COMMONEST = RARITY_TIERS[0];
const RAREST = RARITY_TIERS[RARITY_TIERS.length - 1];
// A `freq` inside a tier: just under its ceiling, or well past the last one's.
const inTier = (index: number): number =>
  Number.isFinite(RARITY_TIERS[index].upTo) ? RARITY_TIERS[index].upTo : 10 ** 9;

// A small map exercising every boundary: the word itself (rank 0, aliased), an aliased
// zone group (rank 1), more zone groups, the LAST zone rank, the first rank past the
// zone (aliased), and a far one. The zone groups carry `freq` values from opposite ends
// of the rarity ladder, so a run's clock is not one flat number.
const RANKS: WordRanks = {
  tropiques: { word: 'tropiques', rank: 0 },
  tropique: { word: 'tropiques', rank: 0 },
  tropicales: { word: 'tropicales', rank: 1, dq: 255, road: 0, freq: inTier(0) },
  tropical: { word: 'tropicales', rank: 1, dq: 255, road: 0, freq: inTier(0) },
  cocotier: { word: 'cocotier', rank: 2, dq: 236, road: 1, freq: inTier(RARITY_TIERS.length - 1) },
  lagon: { word: 'lagon', rank: CLAIM_ZONE, dq: 40, road: 1 }, // no freq: an older artifact
  sable: { word: 'sable', rank: CLAIM_ZONE + 1, dq: 39 },
  sables: { word: 'sable', rank: CLAIM_ZONE + 1, dq: 39 },
  neige: { word: 'neige', rank: 353, dq: 12 },
};

// The claimable zone is not a number this package gets to pick: the #154 artifact draws its
// roads over generation's flat top-ROAD_TOP, and those groups ARE Word mode's playing field,
// so CLAIM_ZONE is that constant restated in TypeScript. Nothing else couples them — retune
// ROAD_TOP alone and the client refuses groups the board has drawn a road for, or draws a
// field it will not let you claim. Cross-language, so it is asserted against the source of
// truth the way the slug/fold fixture is.
describe('CLAIM_ZONE — generation\'s road zone, in TypeScript', () => {
  it('matches distances.py ROAD_TOP', () => {
    const distances = readFileSync(
      new URL('../../../generation/scripts/distances.py', import.meta.url),
      'utf8',
    );
    const declared = /^ROAD_TOP = (\d+)$/m.exec(distances);
    expect(declared, 'ROAD_TOP is no longer a plain literal in distances.py').not.toBeNull();
    expect(Number(declared![1])).toBe(CLAIM_ZONE);
  });
});

describe('judgeWordGuess — the claim boundary', () => {
  it('a zone group is a claim, the zone edge included', () => {
    expect(judgeWordGuess(RANKS, 'tropicales').kind).toBe('claim');
    expect(judgeWordGuess(RANKS, 'lagon').kind).toBe('claim'); // rank == CLAIM_ZONE
  });

  it('the first rank past the zone is a near miss (its rank teaches the boundary)', () => {
    const judged = judgeWordGuess(RANKS, 'sable');
    expect(judged.kind).toBe('near');
    if (judged.kind === 'near') expect(judged.entry.rank).toBe(CLAIM_ZONE + 1);
  });

  it('off-map (no entry at all) is a miss with no rank', () => {
    expect(judgeWordGuess(RANKS, 'guitare').kind).toBe('miss');
  });

  it('the day\'s word itself (rank 0) is free — it is public', () => {
    expect(judgeWordGuess(RANKS, 'tropiques').kind).toBe('zero');
    expect(judgeWordGuess(RANKS, 'tropique').kind).toBe('zero'); // via an alias too
  });
});

describe('wordGuessKey — group-level identity (#104)', () => {
  it('aliases of one group share one identity', () => {
    expect(wordGuessKey(RANKS, 'tropical')).toBe(wordGuessKey(RANKS, 'tropicales'));
    // Group identity also holds outside the zone: an inflection of a counted near
    // miss is the same guess.
    expect(wordGuessKey(RANKS, 'sable')).toBe(wordGuessKey(RANKS, 'sables'));
  });

  it('distinct off-map words are distinct guesses (slug fallback)', () => {
    expect(wordGuessKey(RANKS, 'guitare')).not.toBe(wordGuessKey(RANKS, 'violon'));
  });
});

describe('bonusSeconds — what a claim pays the clock (#163)', () => {
  it('every claim pays the base, and rarity only ever adds to it', () => {
    expect(bonusSeconds(1)).toBe(CLAIM_BASE_SECONDS + COMMONEST.extra);
    for (const tier of RARITY_TIERS) {
      expect(bonusSeconds(Number.isFinite(tier.upTo) ? tier.upTo : 10 ** 9)).toBe(
        CLAIM_BASE_SECONDS + tier.extra,
      );
    }
  });

  it('rarer is never worth less than commoner', () => {
    const paid = RARITY_TIERS.map((_t, i) => bonusSeconds(inTier(i)));
    expect(paid).toEqual([...paid].sort((a, b) => a - b));
    // And the ladder actually climbs — a flat table would pass the check above.
    expect(bonusSeconds(inTier(RARITY_TIERS.length - 1))).toBeGreaterThan(bonusSeconds(1));
  });

  it('an unknown rarity pays the base alone (freq is optional by contract)', () => {
    expect(bonusSeconds(undefined)).toBe(CLAIM_BASE_SECONDS);
  });

  it('the ladder is total and ordered, so no freq falls through it', () => {
    expect(RARITY_TIERS.map((t) => t.upTo)).toEqual(
      [...RARITY_TIERS.map((t) => t.upTo)].sort((a, b) => a - b),
    );
    expect(RAREST.upTo).toBe(Infinity);
  });
});

describe('replayWordRun — the score and the clock, from the log alone', () => {
  it('claims count; the score is the claim count', () => {
    const run = replayWordRun(RANKS, ['tropicales', 'cocotier']);
    expect(run.claimedRanks).toEqual([1, 2]);
  });

  it('the clock gets the SUM of the claims\' bonuses — rarity feeds it, not the score', () => {
    const run = replayWordRun(RANKS, ['tropicales', 'cocotier']);
    // Two claims, one common and one deep in the tail: the score cannot tell them
    // apart, the clock must.
    expect(run.claimedRanks).toHaveLength(2);
    expect(run.bonus).toBe(bonusSeconds(inTier(0)) + bonusSeconds(inTier(RARITY_TIERS.length - 1)));
    expect(runMs(run.bonus)).toBe((START_SECONDS + run.bonus) * 1000);
  });

  it('a claim on a group with no freq still pays the base', () => {
    const run = replayWordRun(RANKS, ['lagon']);
    expect(run.claimedRanks).toEqual([CLAIM_ZONE]);
    expect(run.bonus).toBe(CLAIM_BASE_SECONDS);
  });

  it('near misses and misses buy nothing and cost nothing', () => {
    const run = replayWordRun(RANKS, ['sable', 'neige', 'guitare', 'violon']);
    expect(run.claimedRanks).toEqual([]);
    expect(run.bonus).toBe(0);
    // They are still COUNTED — the board draws them, and they never repeat.
    expect(run.counted.map((g) => g.judged.kind)).toEqual(['near', 'near', 'miss', 'miss']);
  });

  it('a group-level repeat is free: it neither claims nor pays twice', () => {
    // 'tropical' repeats the claimed 'tropicales' group; 'sables' repeats the counted
    // near miss 'sable'.
    const run = replayWordRun(RANKS, ['tropicales', 'tropical', 'sable', 'sables']);
    expect(run.claimedRanks).toEqual([1]);
    expect(run.bonus).toBe(bonusSeconds(inTier(0)));
    expect(run.counted).toHaveLength(2);
  });

  it('the day\'s word is free and skipped in the log', () => {
    const run = replayWordRun(RANKS, ['tropiques', 'cocotier']);
    expect(run.claimedRanks).toEqual([2]);
    expect(run.counted.map((g) => g.typed)).toEqual(['cocotier']);
  });

  it('nothing in the log ends the run — that is the deadline\'s to say', () => {
    // Whatever the log holds, the walk keeps walking: the clock is wall-clock, so a
    // replay cannot know when time ran out (the round state does).
    const run = replayWordRun(RANKS, ['sable', 'neige', 'guitare', 'violon', 'tropicales']);
    expect(run.claimedRanks).toEqual([1]); // the late claim happened
    expect(run).not.toHaveProperty('ended');
  });
});
