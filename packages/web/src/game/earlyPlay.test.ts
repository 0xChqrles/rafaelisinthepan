// CONTRACT (#273): the night's play on tomorrow's sentence ends at the FIRST PROGRESS —
// a guess that beats a start word, an exact hit included — or after EARLY_GUESS_CAP
// guesses, whichever comes first. The server refuses the append after that point; the
// client locks its input off the same two facts, read from its own play log, so the two
// ends agree on when the night ends without the refusal ever being what says so.

import { describe, expect, it } from 'vitest';
import { EARLY_GUESS_CAP, type RankMap, type RuntimeHole } from '@whippin/shared';
import { earlyLocked } from './earlyPlay';

const RANKS: RankMap = {
  foret: {
    foret: { word: 'forêt', rank: 0 },
    bois: { word: 'bois', rank: 5 },
    chemin: { word: 'chemin', rank: 87 },
    sentier: { word: 'sentier', rank: 200 },
  },
  ancienne: {
    ancienne: { word: 'ancienne', rank: 0 },
    vieille: { word: 'vieille', rank: 40 },
  },
};

function holes(): RuntimeHole[] {
  return [
    { pos: 1, secret: 'foret', word: 'chemin', rank: 87, startRank: 87 },
    { pos: 2, secret: 'ancienne', word: 'vieille', rank: 40, startRank: 40 },
  ];
}

describe('earlyLocked — when the night\'s play ends (#273)', () => {
  it('an untouched round is open', () => {
    expect(earlyLocked(holes(), RANKS, [])).toBe(false);
  });

  it('a guess that moves NOTHING leaves it open — a miss, or a word farther than the start', () => {
    expect(earlyLocked(holes(), RANKS, ['zzz'])).toBe(false);
    expect(earlyLocked(holes(), RANKS, ['sentier'])).toBe(false);
    // The start word itself is no progress either: rank equal, not better.
    expect(earlyLocked(holes(), RANKS, ['chemin'])).toBe(false);
  });

  it('locks right after the guess that beats a start word', () => {
    expect(earlyLocked(holes(), RANKS, ['zzz', 'bois'])).toBe(true);
  });

  it('an exact hit is progress too', () => {
    expect(earlyLocked(holes(), RANKS, ['ancienne'])).toBe(true);
  });

  it(`locks after ${EARLY_GUESS_CAP} guesses that moved nothing`, () => {
    const misses = Array.from({ length: EARLY_GUESS_CAP }, (_, i) => `miss${i}`);
    expect(earlyLocked(holes(), RANKS, misses.slice(0, -1))).toBe(false);
    expect(earlyLocked(holes(), RANKS, misses)).toBe(true);
  });
});
