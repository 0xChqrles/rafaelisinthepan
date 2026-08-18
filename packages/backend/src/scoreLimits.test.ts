import { describe, expect, it } from 'vitest';
import type { Puzzle, WordPuzzle } from '@whippin/shared';
import enVocab from '../../web/public/vocab/en.json';
import frVocab from '../../web/public/vocab/fr.json';
import {
  SENTENCE_SCORE_MAX_BY_LANG,
  WORD_SCORE_ZONE,
  sentenceScoreMaximum,
  wordScoreMaximum,
} from './scoreLimits';

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
  it('pins sentence ceilings to the exact committed existence sets', () => {
    // This is the drift alarm: regenerating a vocab changes what a real client can count,
    // and must force the server-side validator to move in the same commit.
    expect(SENTENCE_SCORE_MAX_BY_LANG).toEqual({ en: enVocab.length, fr: frVocab.length });
    expect(sentenceScoreMaximum('en', PUZZLE)).toBe(enVocab.length);
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
