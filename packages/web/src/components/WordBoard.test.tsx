import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WordBoardModel } from '../game/wordBoard';
import WordBoard from './WordBoard';

describe('WordBoard accessibility mirror', () => {
  it('counts a --no-roads neighborhood and its claimed stations', () => {
    const model: WordBoardModel = {
      word: 'phare',
      lanes: 1,
      stations: [
        { rank: 1, dq: 255, road: null, word: 'balise', claimed: true },
        { rank: 2, dq: 180, road: null, word: null, claimed: false },
      ],
      outside: [],
      misses: [],
      ended: false,
      maxRank: 2,
    };

    const markup = renderToStaticMarkup(<WordBoard model={model} lang="en" />);

    expect(markup).toContain('neighborhood: 2 stops, 1 found');
    expect(markup).not.toContain('neighborhood: 0 stops, 0 found');
  });
});
