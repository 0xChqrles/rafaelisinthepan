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
      maxRank: 2,
    };

    const markup = renderToStaticMarkup(<WordBoard model={model} lang="en" />);

    expect(markup).toContain('neighborhood: 2 stops, 1 found');
    expect(markup).not.toContain('neighborhood: 0 stops, 0 found');
  });
});

// CONTRACT: a station wears its ROAD's colour whenever it is on one — being on a road and the
// line FORKING are different questions, and conflating them cost the whole board its colour on
// a single-road neighborhood (fixed 2026-08-07; the stricter road rules made that case common).
// The `--no-roads` map is the real other side of it: there is no road, so there is no colour,
// and that distinction is what keeps this from being restated as "always colour it".
describe('WordBoard lane treatment', () => {
  const board = (road: number | null): string =>
    renderToStaticMarkup(
      <WordBoard
        model={{
          word: 'vie',
          lanes: 1,
          stations: [
            { rank: 1, dq: 255, road, word: 'existence', claimed: true },
            { rank: 2, dq: 180, road, word: null, claimed: false },
          ],
          outside: [],
          misses: [],
          maxRank: 2,
        }}
        lang="en"
      />,
    );

  it('colours a ONE-road neighborhood — one route is still a route', () => {
    expect(board(0)).toContain('on-lane');
  });

  it('leaves a --no-roads neighborhood uncoloured — there is no road to name', () => {
    expect(board(null)).not.toContain('on-lane');
  });
});
