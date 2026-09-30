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

  it('is strictly decreasing in rank (closer = higher)', () => {
    for (const [a, b] of [[1, 2], [2, 10], [10, 100], [100, 999]]) {
      expect(s(a, 1000)).toBeGreaterThan(s(b, 1000));
    }
  });

  it('is LOGARITHMIC in rank, not linear', () => {
    // ln(10) / ln(100) = 1/2: a tenth of the way out in rank is half the way out in s.
    expect(s(9, 99)).toBeCloseTo(0.5, 12);
    // s(9) = 3/4 and s(99) = 1/2 over ln(10000), so the hole is halfway from its start.
    expect(holeProgress(9, 99, 9999)).toBeCloseTo(0.5, 12);
  });

  it('runs 0 at the start rank to 1 at the solve, clamped at both ends', () => {
    expect(holeProgress(87, 87, 500)).toBeCloseTo(0, 10);
    expect(holeProgress(0, 87, 500)).toBeCloseTo(1, 10);
    // A guess FARTHER than the start cannot push a hole negative (the game never lets a
    // rank regress, but a derivation reading a raw log must not be able to either).
    expect(holeProgress(400, 87, 500)).toBe(0);
  });

  it('is monotonic between the two: a closer rank never scores lower', () => {
    expect(holeProgress(50, 200, 1000)).toBeGreaterThan(holeProgress(150, 200, 1000));
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

  // "privée"/"prive" alias to the privé entry in BOTH maps (rank 2 in a, rank 90 in b).
  // "portes" is an alias of a DIFFERENT group (porte, rank 5), which map b never knows.
  const ALIASED: RankMap = {
    a: {
      prive: { word: 'privé', rank: 2 },
      privee: { word: 'privé', rank: 2 },
      porte: { word: 'porte', rank: 5 },
      portes: { word: 'porte', rank: 5 },
    },
    b: {
      prive: { word: 'privé', rank: 90 },
      privee: { word: 'privé', rank: 90 },
    },
  };

  it('two inflections of one word share one identity when every map aliases them', () => {
    expect(guessKey(ALIASED, 'privee')).toBe(guessKey(ALIASED, 'prive'));
  });

  it('different words (even aliased ones) keep distinct identities', () => {
    expect(guessKey(ALIASED, 'porte')).not.toBe(guessKey(ALIASED, 'prive'));
    expect(guessKey(ALIASED, 'portes')).toBe(guessKey(ALIASED, 'porte'));
  });

  it('is the outcome on EVERY hole, so a variant one map ranks differently is its own try', () => {
    // Same rank in a, different rank in b: the player learns something new from the
    // second one, so it cannot be folded into the first.
    const split: RankMap = {
      a: { chaud: { word: 'chaud', rank: 4 }, chaude: { word: 'chaud', rank: 4 } },
      b: { chaud: { word: 'chaud', rank: 7 }, chaude: { word: 'chaude', rank: 9 } },
    };
    expect(guessKey(split, 'chaude')).not.toBe(guessKey(split, 'chaud'));
  });

  it('never fuses a SOLVING guess into a duplicate of a near miss (fr day 20667)', () => {
    // The real regression: in the FIRST map the singular and the plural fold onto one
    // group (`maniérés`, rank 6783), while in the hole's OWN map the plural IS the secret
    // (rank 0) and the singular is a different group two ranks out. Anchoring the identity
    // on the first map made the plural a repeat of the singular, so the guess that solved
    // the sentence never entered `tried` — and the run ruler, the share card, the emoji
    // row and the score all lost it.
    const collided: RankMap = {
      tropiques: {
        maniere: { word: 'maniérés', rank: 6783 },
        manieres: { word: 'maniérés', rank: 6783 },
      },
      manieres: {
        maniere: { word: 'manière', rank: 2 },
        manieres: { word: 'manières', rank: 0 },
      },
    };
    expect(guessKey(collided, 'manieres')).not.toBe(guessKey(collided, 'maniere'));
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
