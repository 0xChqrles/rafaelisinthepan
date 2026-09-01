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
    { rank: 1, rarity: COMMON, word: 'balise', claimed: true },
    { rank: 2, rarity: COMMON, word: null, claimed: false },
  ],
  ...over,
});

const render = (over: Partial<WordBoardModel> = {}): string =>
  renderToStaticMarkup(<WordBoard model={model(over)} lang="en" />);

describe('WordBoard accessibility mirror', () => {
  it('states the field per GRADE — what the word colours say to everyone else', () => {
    const markup = render({
      grades: [COMMON, RARE],
      stations: [
        { rank: 1, rarity: COMMON, word: 'balise', claimed: true },
        { rank: 2, rarity: RARE, word: null, claimed: false },
        { rank: 3, rarity: RARE, word: null, claimed: false },
      ],
    });

    expect(markup).toContain('neighborhood: 3 stops by rarity (COMMON 1, RARE 2), 1 found');
  });

  it('counts a single-grade neighborhood rather than announcing an empty field', () => {
    expect(render()).toContain('neighborhood: 2 stops by rarity (COMMON 2), 1 found');
  });

  it('names a revealed word by its grade — the word colour, in words', () => {
    expect(render({ grades: [COMMON, RARE] })).toContain('rank 1 — balise — COMMON');
  });
});

// CONTRACT: rarity is said in the WORD's COLOUR (user-decided 2026-08-11; the grid since
// 2026-09-01 keeps it). Every zone word carries its grade's `--rarity-c` (COMMON is the
// ladder's floor, so a word can never be gradeless); a CLAIMED word is marked apart from
// one merely named, and a censored one is still drawn, as `???`.
describe('WordBoard rarity colours', () => {
  it("paints a word in its own GRADE's colour", () => {
    const markup = render({
      grades: [COMMON, RARE],
      stations: [
        { rank: 1, rarity: COMMON, word: 'balise', claimed: true },
        { rank: 2, rarity: RARE, word: 'fanal', claimed: true },
      ],
    });

    expect(markup).toContain(RARITY_COLORS[COMMON]);
    expect(markup).toContain(RARITY_COLORS[RARE]);
  });

  it('marks a claimed word apart from a named one, and draws a censored one as ???', () => {
    const markup = render({
      stations: [
        { rank: 1, rarity: COMMON, word: 'balise', claimed: true },
        { rank: 2, rarity: COMMON, word: 'fanal', claimed: false },
        { rank: 3, rarity: COMMON, word: null, claimed: false },
      ],
    });
    expect(markup.match(/wb-claimed/g)).toHaveLength(1);
    expect(markup).toContain('???');
  });
});
