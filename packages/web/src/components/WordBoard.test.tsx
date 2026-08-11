import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WordBoardModel } from '../game/wordBoard';
import { RARITY_NAMES } from '../game/wordGame';
import { RARITY_COLORS } from './rarity';
import WordBoard from './WordBoard';

const [COMMON, , RARE] = RARITY_NAMES;

const model = (over: Partial<WordBoardModel> = {}): WordBoardModel => ({
  word: 'phare',
  grades: [COMMON],
  stations: [
    { rank: 1, dq: 255, rarity: COMMON, word: 'balise', claimed: true },
    { rank: 2, dq: 180, rarity: COMMON, word: null, claimed: false },
  ],
  outside: [],
  misses: [],
  maxRank: 2,
  ...over,
});

const render = (over: Partial<WordBoardModel> = {}): string =>
  renderToStaticMarkup(<WordBoard model={model(over)} lang="en" />);

describe('WordBoard accessibility mirror', () => {
  it('states the field per GRADE — what station colours say to everyone else', () => {
    const markup = render({
      grades: [COMMON, RARE],
      stations: [
        { rank: 1, dq: 255, rarity: COMMON, word: 'balise', claimed: true },
        { rank: 2, dq: 180, rarity: RARE, word: null, claimed: false },
        { rank: 3, dq: 90, rarity: RARE, word: null, claimed: false },
      ],
      maxRank: 3,
    });

    expect(markup).toContain('neighborhood: 3 stops by rarity (COMMON 1, RARE 2), 1 found');
  });

  it('counts a single-grade neighborhood rather than announcing an empty field', () => {
    expect(render()).toContain('neighborhood: 2 stops by rarity (COMMON 2), 1 found');
  });

  it('names a revealed stop by its grade — the station colour, in words', () => {
    expect(render({ grades: [COMMON, RARE] })).toContain('rank 1 — balise — COMMON');
  });
});

// CONTRACT: rarity is said in the WORD's COLOUR on one trunk (user-decided 2026-08-11,
// superseding 2026-08-10's grade-per-lane fork — the board is the sentence route's exact
// drawing now). Every ZONE station carries its grade's `--rarity-c` (COMMON is the ladder's
// floor, so a station can never be gradeless); a near miss out on the trunk belongs to no
// grade and carries none.
describe('WordBoard rarity colours', () => {
  it("paints a station in its own GRADE's colour, not the route map's lane hues", () => {
    const markup = render({
      grades: [COMMON, RARE],
      stations: [
        { rank: 1, dq: 255, rarity: COMMON, word: 'balise', claimed: true },
        { rank: 2, dq: 180, rarity: RARE, word: 'fanal', claimed: true },
      ],
    });

    expect(markup).toContain(RARITY_COLORS[COMMON]);
    expect(markup).toContain(RARITY_COLORS[RARE]);
    // The fork is gone: no lane class, no junction — one trunk, like the sentence line.
    expect(markup).not.toContain('on-lane');
    expect(markup).not.toContain('route-junction');
  });

  it('leaves a near miss uncoloured — it belongs to no grade', () => {
    const markup = render({
      stations: [],
      outside: [{ rank: 300, dq: 20, word: 'sable' }],
      maxRank: 300,
    });

    expect(markup).not.toContain('--rarity-c');
  });
});
