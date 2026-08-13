import { describe, expect, it } from 'vitest';
import type { Puzzle, WordPuzzle } from '@whippin/shared';
import enVocab from '../../web/public/vocab/en.json';
import frVocab from '../../web/public/vocab/fr.json';
import {
  SENTENCE_SCORE_MAX_BY_LANG,
  WORD_SCORE_ZONE,
  histogramBuckets,
  scoreBucket,
  scoreRanges,
  sentenceScoreMaximum,
  wordScoreMaximum,
} from './scoreBuckets';

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

describe('fixed score buckets (#169)', () => {
  it('covers each mode contiguously, with no gaps or overlap', () => {
    expect(scoreRanges('sentence')[0].min).toBe(1);
    expect(scoreRanges('word')[0]).toEqual({ min: 0, max: 0 });
    for (const mode of ['sentence', 'word'] as const) {
      const ranges = scoreRanges(mode);
      for (let index = 1; index < ranges.length; index += 1) {
        expect(ranges[index].min).toBe(ranges[index - 1].max + 1);
      }
    }
    expect(scoreRanges('word').at(-1)?.max).toBe(WORD_SCORE_ZONE);
  });

  it('assigns inclusive boundaries to exactly one bucket', () => {
    const ranges = scoreRanges('sentence');
    for (const [index, range] of ranges.entries()) {
      expect(scoreBucket('sentence', range.min)).toBe(index);
      expect(scoreBucket('sentence', range.max)).toBe(index);
    }
    expect(scoreBucket('sentence', 0)).toBeNull();
    expect(scoreBucket('word', WORD_SCORE_ZONE + 1)).toBeNull();
    expect(scoreBucket('word', 1.5)).toBeNull();
  });

  it('returns the committed ranges with their counter values', () => {
    expect(histogramBuckets('word', [7, 3]).slice(0, 3)).toEqual([
      { min: 0, max: 0, count: 7 },
      { min: 1, max: 5, count: 3 },
      { min: 6, max: 10, count: 0 },
    ]);
  });
});

describe('puzzle-aware score limits', () => {
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
