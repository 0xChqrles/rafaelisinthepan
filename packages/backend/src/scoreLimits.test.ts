import { describe, expect, it } from 'vitest';
import { type WordPuzzle } from '@whippin/shared';
import { WORD_SCORE_ZONE, wordScoreMaximum } from './scoreLimits';

// The SENTENCE ceiling is gone with #203's client-claimed score: the server counts the
// unique tries in the log it stored, so there is no range left to validate. What survives
// is Word mode's claim ceiling, which is not a score check but a FIELD check — how many
// groups a day's artifact actually offers, which is what an end-of-run log is refused
// against.
describe('the Word field\'s claim ceiling (#169/#202)', () => {
  it('counts distinct claimable Word groups, not alias keys or out-of-zone ranks', () => {
    const word: WordPuzzle = {
      lang: 'en',
      word: { word: 'ocean', slug: 'ocean' },
      ranks: {
        ocean: { word: 'ocean', rank: 0 },
        sea: { word: 'sea', rank: 1 },
        seas: { word: 'sea', rank: 1 },
        water: { word: 'water', rank: 2 },
        distant: { word: 'distant', rank: WORD_SCORE_ZONE + 1 },
      },
    };
    expect(wordScoreMaximum(word)).toBe(2);
  });
});
