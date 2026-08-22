// CONTRACT (#203): the readings BOTH ends perform over one guess log. They moved here from
// the web when the server started deriving a round's `solved`, its `progress` and its score
// from the log it stores — two spellings would let the number on screen disagree with the
// one the leaderboard recorded and the calendar fills from.
//
//   s(rank)   = 1 - ln(rank + 1) / ln(N + 1)                     // s(0) = 1
//   p_hole    = (s(rank) - s(start)) / (1 - s(start))            // 0 at start, 1 solved
//   guessKey  = the guess's whole OUTCOME (its rank in EVERY map), so two guesses count
//               once only when they are indistinguishable (#104)
//   countTries = the SENTENCE SCORE: distinct identities in a log

import { describe, expect, it } from 'vitest';
import type { RankMap } from './types';
import { countTries, guessKey, holeProgress, rankCount, s } from './scoring';

const RANKS: RankMap = {
  foret: {
    foret: { word: 'forêt', rank: 0 },
    foretz: { word: 'forêt', rank: 0 }, // an alias of the SAME group
    bois: { word: 'bois', rank: 5 },
    chemin: { word: 'chemin', rank: 87 },
  },
  ancienne: {
    ancienne: { word: 'ancienne', rank: 0 },
    bois: { word: 'bois', rank: 40 },
    vieille: { word: 'vieille', rank: 40 },
  },
};

describe('s + holeProgress — the reconstruction curve', () => {
  it('is 1 at the secret and falls with distance', () => {
    expect(s(0, 100)).toBe(1);
    expect(s(1, 100)).toBeLessThan(1);
    expect(s(99, 100)).toBeLessThan(s(1, 100));
  });

  it('runs 0 at the start rank to 1 at the solve, clamped at both ends', () => {
    expect(holeProgress(87, 87, 500)).toBeCloseTo(0, 10);
    expect(holeProgress(0, 87, 500)).toBeCloseTo(1, 10);
    // A guess FARTHER than the start cannot push a hole negative (the game never lets a
    // rank regress, but a derivation reading a raw log must not be able to either).
    expect(holeProgress(400, 87, 500)).toBe(0);
  });

  it('treats an already-perfect start as solved-or-nothing rather than dividing by zero', () => {
    expect(holeProgress(0, 0, 10)).toBe(1);
    expect(holeProgress(3, 0, 10)).toBe(0);
  });
});

describe('rankCount — N is GROUPS, not keys', () => {
  it('counts distinct rank values, so aliases do not inflate the base', () => {
    // 4 keys, 3 distinct ranks (0, 0, 5, 87).
    expect(rankCount(RANKS.foret)).toBe(3);
    expect(rankCount(RANKS.ancienne)).toBe(2);
  });
});

describe('guessKey — the counted-try identity (#104)', () => {
  it('is the guess\'s WHOLE outcome: its rank in every map, in key order', () => {
    expect(guessKey(RANKS, 'bois')).toBe('5|40');
    // Unknown to a map is -1, which is why a rank must be non-negative everywhere else.
    expect(guessKey(RANKS, 'chemin')).toBe('87|-1');
  });

  it('collapses two surfaces of ONE group and separates surfaces that differ anywhere', () => {
    expect(guessKey(RANKS, 'foretz')).toBe(guessKey(RANKS, 'foret'));
    // `vieille` and `bois` share the second map's rank but not the first's: two tries.
    expect(guessKey(RANKS, 'vieille')).not.toBe(guessKey(RANKS, 'bois'));
  });

  it('falls back to the folded slug for a guess no map knows', () => {
    expect(guessKey(RANKS, 'zzz')).toBe('zzz');
    // Two different cold misses stay two different tries.
    expect(guessKey(RANKS, 'zzz')).not.toBe(guessKey(RANKS, 'yyy'));
  });
});

describe('countTries — the sentence score', () => {
  it('counts DISTINCT identities, which is what the server must dedup a merged log by', () => {
    // A log two devices merged into: `foret` and `foretz` are one try, and a repeat of a
    // cold miss is one try. Four entries, two identities.
    expect(countTries(RANKS, ['foret', 'foretz', 'zzz', 'zzz'])).toBe(2);
  });

  it('agrees with a client-side log that was deduped as it was written', () => {
    // The web appends only new identities, so its own log's LENGTH is this number — which
    // is exactly why one function has to answer both.
    const local = ['bois', 'chemin', 'zzz'];
    expect(countTries(RANKS, local)).toBe(local.length);
  });

  it('is 0 for an empty log', () => {
    expect(countTries(RANKS, [])).toBe(0);
  });
});
