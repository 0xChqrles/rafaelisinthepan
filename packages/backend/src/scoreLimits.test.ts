import { describe, expect, it } from 'vitest';
import { VOCAB_BUILDS, type Puzzle, type WordPuzzle } from '@whippin/shared';
import { WORD_SCORE_ZONE, sentenceScoreMaximum, wordScoreMaximum } from './scoreLimits';

const PUZZLE: Puzzle = {
  lang: 'en',
  words: ['one'],
  holes: [
    {
      pos: 0,
      secret: { word: 'one', slug: 'one' },
      start: { word: 'two', slug: 'two' },
      start_rank: 2,
    },
  ],
  ranks: { one: { one: { word: 'one', rank: 0 }, two: { word: 'two', rank: 2 } } },
};

describe('puzzle-aware score limits (#169)', () => {
  it('takes the sentence ceiling from the generated vocab metadata', () => {
    // The ceiling is the existence set's size, and #200 has generation state it: a
    // regenerated vocabulary moves this bound in the commit that ships it, with no
    // number to copy across by hand. That the metadata matches the committed sets is
    // shared/vocab.test.ts's contract, asserted once where the file lives.
    expect(sentenceScoreMaximum('en', PUZZLE)).toBe(VOCAB_BUILDS.en.vocabSize);
    expect(sentenceScoreMaximum('fr', PUZZLE)).toBe(VOCAB_BUILDS.fr.vocabSize);
    // A language the pipeline never built a vocabulary for has no ceiling to enforce.
    expect(sentenceScoreMaximum('de', PUZZLE)).toBeNull();
  });

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
