// CONTRACT (#156 — Word mode rules, decided 2026-08-03):
//   - score = number of top-zone (CLAIM_ZONE = the #154 road zone, 150) groups claimed
//     before the run ends;
//   - the run ends after STRIKES_TO_END CONSECUTIVE incorrect guesses — that count is a
//     tuning knob, so every sequence below is DERIVED from it rather than typed out;
//   - incorrect = a valid vocab word, not already tried, ranked OUTSIDE the zone —
//     including off-map (beyond the TOP_K cap); a ranked near miss shows its rank;
//   - free (no strike, no claim): repeats — deduped at GROUP level (#104: inflections/
//     aliases of a tried group are a repeat) — and the day's word itself (it is public).
// Asserted against the spec, not the implementation.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type { WordRanks } from '@whippin/shared';
import {
  CLAIM_ZONE,
  STRIKES_TO_END,
  judgeWordGuess,
  replayWordRun,
  wordGuessKey,
} from './wordGame';

// A small map exercising every boundary: the word itself (rank 0, aliased), an aliased
// zone group (rank 1), more zone groups, the LAST zone rank, the first rank past the
// zone (aliased), and a far one.
const RANKS: WordRanks = {
  tropiques: { word: 'tropiques', rank: 0 },
  tropique: { word: 'tropiques', rank: 0 },
  tropicales: { word: 'tropicales', rank: 1, dq: 255, road: 0 },
  tropical: { word: 'tropicales', rank: 1, dq: 255, road: 0 },
  cocotier: { word: 'cocotier', rank: 2, dq: 236, road: 1 },
  lagon: { word: 'lagon', rank: CLAIM_ZONE, dq: 40, road: 1 },
  sable: { word: 'sable', rank: CLAIM_ZONE + 1, dq: 39 },
  sables: { word: 'sable', rank: CLAIM_ZONE + 1, dq: 39 },
  neige: { word: 'neige', rank: 353, dq: 12 },
};

// `n` DISTINCT off-map words — distinct guesses by the slug fallback, so each one strikes.
const offMap = (n: number, tag: string): string[] =>
  Array.from({ length: n }, (_, i) => `motfaux${tag}${i}`);

// `n` DISTINCT incorrect guesses: the map's two ranked near misses first, so a run also
// exercises the near strike, then off-map words. Derived from STRIKES_TO_END at the call
// site rather than typed out, so retuning the constant cannot quietly stop testing the end.
const strikeRun = (n: number, tag = 'a'): string[] =>
  ['sable', 'neige', ...offMap(Math.max(0, n - 2), tag)].slice(0, n);

// The claimable zone is not a number this package gets to pick: the #154 artifact draws its
// roads over generation's flat top-ROAD_TOP, and those groups ARE Word mode's playing field,
// so CLAIM_ZONE is that constant restated in TypeScript. Nothing else couples them — retune
// ROAD_TOP alone and the client strikes on groups the board has drawn a road for, or draws a
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

  it('the first rank past the zone is a near strike (its rank teaches the boundary)', () => {
    const judged = judgeWordGuess(RANKS, 'sable');
    expect(judged.kind).toBe('near');
    if (judged.kind === 'near') expect(judged.entry.rank).toBe(CLAIM_ZONE + 1);
  });

  it('off-map (no entry at all) is a strike with no rank', () => {
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
    // Group identity also holds at the STRIKE boundary: an inflection of a counted
    // near miss is the same guess.
    expect(wordGuessKey(RANKS, 'sable')).toBe(wordGuessKey(RANKS, 'sables'));
  });

  it('distinct off-map words are distinct guesses (slug fallback)', () => {
    expect(wordGuessKey(RANKS, 'guitare')).not.toBe(wordGuessKey(RANKS, 'violon'));
  });
});

describe('replayWordRun — scoring and the end of the run', () => {
  it('claims count; the score is the claim count', () => {
    const run = replayWordRun(RANKS, ['tropicales', 'cocotier']);
    expect(run.claimedRanks).toEqual([1, 2]);
    expect(run.strikes).toBe(0);
    expect(run.ended).toBe(false);
  });

  it(`ends after ${STRIKES_TO_END} CONSECUTIVE incorrect guesses, and not before`, () => {
    const run = replayWordRun(RANKS, strikeRun(STRIKES_TO_END));
    expect(run.strikes).toBe(STRIKES_TO_END);
    expect(run.ended).toBe(true);
    // One short is still a live run — the threshold is exact, not "about this many".
    const short = replayWordRun(RANKS, strikeRun(STRIKES_TO_END - 1));
    expect(short.strikes).toBe(STRIKES_TO_END - 1);
    expect(short.ended).toBe(false);
  });

  it('a claim RESETS the consecutive count', () => {
    // One strike short of the end, then a claim — after which the run survives another full
    // stretch one short of the end, which it could not do if the count had carried over.
    const run = replayWordRun(RANKS, [
      ...strikeRun(STRIKES_TO_END - 1),
      'tropicales',
      ...offMap(STRIKES_TO_END - 1, 'b'),
    ]);
    expect(run.ended).toBe(false);
    expect(run.strikes).toBe(STRIKES_TO_END - 1);
    expect(run.claimedRanks).toEqual([1]);
  });

  it('a group-level repeat is free: it neither claims again nor breaks the strike run', () => {
    // 'tropical' repeats the claimed 'tropicales' group; 'sables' repeats the counted
    // near miss 'sable'. Neither adds a claim, a strike, or a reset.
    const run = replayWordRun(RANKS, ['tropicales', 'tropical', 'sable', 'sables', 'neige']);
    expect(run.claimedRanks).toEqual([1]);
    expect(run.strikes).toBe(2);
    expect(run.ended).toBe(false);
  });

  it('the day\'s word is free and skipped in the log', () => {
    const run = replayWordRun(RANKS, ['tropiques', 'cocotier']);
    expect(run.claimedRanks).toEqual([2]);
    expect(run.strikes).toBe(0);
  });

  it('nothing counts past the end of the run', () => {
    const run = replayWordRun(RANKS, [...strikeRun(STRIKES_TO_END), 'tropicales']);
    expect(run.ended).toBe(true);
    expect(run.claimedRanks).toEqual([]); // the late claim never happened
  });
});
