// CONTRACT (issue #17): how a puzzle is named/located in the store. The encoding is
// shared by the local FS store and the S3 uploader (#4), so it must match the day/lang
// contract of #2/#6: "<date>/<slug1>-<slug2>-<slug3>.<lang>.json", secret slugs in
// SENTENCE order. These assert the spec, not the implementation.

import { describe, it, expect } from 'vitest';
import type { Puzzle } from '@rafaelisinthepan/shared';
import { isValidDate, puzzleObjectName, puzzleKey } from './layout';

// Holes deliberately out of sentence order to prove the name sorts by `pos`.
const PUZZLE: Puzzle = {
  lang: 'fr',
  words: ['le', 'vent', 'se', 'lève'],
  holes: [
    { pos: 3, secret: { word: 'lève', slug: 'leve' }, start: { word: 'x', slug: 'x' }, start_rank: 1 },
    { pos: 1, secret: { word: 'vent', slug: 'vent' }, start: { word: 'y', slug: 'y' }, start_rank: 1 },
  ],
  ranks: {},
};

describe('puzzleObjectName — secret slugs in sentence order + lang suffix', () => {
  it('joins slugs by "-", orders by pos, ends ".<lang>.json"', () => {
    expect(puzzleObjectName(PUZZLE)).toBe('vent-leve.fr.json');
  });

  it('is ASCII (uses slugs, never the accented display words)', () => {
    expect(puzzleObjectName(PUZZLE)).toMatch(/^[a-z0-9-]+\.[a-z]{2}\.json$/);
  });
});

describe('puzzleKey — <date>/<name>', () => {
  it('prefixes the game day', () => {
    expect(puzzleKey('2026-06-29', PUZZLE)).toBe('2026-06-29/vent-leve.fr.json');
  });
});

describe('isValidDate — strict real-calendar YYYY-MM-DD', () => {
  it('accepts a real date', () => {
    expect(isValidDate('2026-06-29')).toBe(true);
  });
  it('rejects malformed / impossible dates', () => {
    for (const bad of ['2026-6-9', '2026/06/29', '2026-13-01', '2026-02-30', 'today', '']) {
      expect(isValidDate(bad)).toBe(false);
    }
  });
});
