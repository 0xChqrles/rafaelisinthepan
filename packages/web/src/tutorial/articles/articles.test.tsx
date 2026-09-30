import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WordPuzzle } from '@whippin/shared';
import chat from '../scripts/fr.chat.json';
import { articleFor, articleText } from '.';
import Rich from './Rich';
import { frenchSpaces } from './typeset';
import type { Article, Block, Figure } from './types';
import { LEVELS, PLAY_LEVEL } from '../levels';
import { LANGS } from '../../langs';

const articles: [string, number, Article][] = LEVELS.filter((l) => l.level !== PLAY_LEVEL).flatMap((l) =>
  LANGS.flatMap((lang): [string, number, Article][] => {
    const article = articleFor(lang.code, l.level);
    return article ? [[lang.code, l.level, article]] : [];
  }),
);
const blocks = (a: Article): Block[] => a.sections.flatMap((s) => s.blocks);
const figures = (a: Article): Figure[] => blocks(a).flatMap((b) => ('fig' in b ? [b.fig] : []));

describe('the article levels’ data', () => {
  it('exist for the French levels', () => {
    expect(articles.filter(([lang]) => lang === 'fr').map(([, n]) => n)).toEqual([2, 3, 4, 5]);
  });

  it.each(articles)('%s level %i: every backtick and ** mark is closed', (_lang, _n, article) => {
    for (const text of articleText(article)) {
      expect((text.match(/`/g) ?? []).length % 2, text).toBe(0);
      expect((text.match(/\*\*/g) ?? []).length % 2, text).toBe(0);
    }
  });

  it.each(articles)('%s level %i: every figure is self-consistent', (_lang, _n, article) => {
    for (const fig of figures(article)) {
      if (fig.kind === 'plane') {
        const n = fig.states[0].length;
        for (const state of fig.states) expect(state.map((p) => p.word)).toEqual(fig.states[0].map((p) => p.word));
        for (const [a, b] of fig.edges) expect(a < n && b < n).toBe(true);
        if (fig.tabs) expect(fig.tabs.length).toBe(fig.states.length);
      }
      if (fig.kind === 'words') {
        for (const list of fig.lists) for (const w of list.marked ?? []) expect(list.words).toContain(w);
        if (fig.tabs) for (const list of fig.lists) expect(list.label).toBeTruthy();
      }
      if (fig.kind === 'arcs') {
        expect(fig.weights.length).toBe(fig.tokens.length);
        // Attention is causal: the focus only listens to what comes before it.
        fig.weights.forEach((w, i) => {
          if (i >= fig.focus) expect(w).toBeNull();
        });
      }
      if (fig.kind === 'ranks') for (const w of fig.more) expect(fig.board.ranks[w], w).toBeDefined();
      if (fig.kind === 'tournament') {
        const wins = fig.rows.map((r) => r.win);
        expect(wins).toEqual([...wins].sort((a, b) => b - a));
      }
    }
  });
});

// The prose QUOTES the bundled board (the game's own embedding): if the board is ever
// regenerated, these are the sentences to re-read.
describe('what the French level 2 says about chat’s neighbours', () => {
  const board = chat as WordPuzzle;
  it('chien is 4th, renard 20th, souris 51st and loup 89th', () => {
    expect(board.ranks.chien.rank).toBe(4);
    // One rank for a word's forms, and accents not typed: chiens, chienne ⇒ chien⁴, felin ⇒ félin⁵.
    expect(board.ranks.chiens.rank).toBe(4);
    expect(board.ranks.chienne.rank).toBe(4);
    expect(board.ranks.felin).toMatchObject({ word: 'félin', rank: 5 });
    expect(board.ranks.renard.rank).toBe(20);
    expect(board.ranks.souris.rank).toBe(51);
    expect(board.ranks.loup.rank).toBe(89);
  });
  it('the text says so', () => {
    const text = articleText(articleFor('fr', 2)!).join(' ');
    expect(text).toContain('`chien^4`');
    expect(text).toContain('`félin^5`');
    expect(text).toContain('89e position');
  });
});

describe('the inline markup', () => {
  it('renders a quoted word in the pixel face, a ranked one as the held chip with its exponent', () => {
    const html = renderToStaticMarkup(<Rich text="le mot `chat` et `chien^4`" />);
    expect(html).toContain('<span class="ar-word">chat</span>');
    // The secret itself reads found: `chat^0` is the solve's ink, no chip, no exponent.
    expect(renderToStaticMarkup(<Rich text="`chat^0`" />)).toBe('<span class="ar-solved">chat</span>');
    expect(html).toContain('<span class="ar-held-text">chien</span>');
    expect(html).toMatch(/<sup class="ar-rank"[^>]*>4<\/sup>/);
  });
  it('renders ___ as an empty hole and **x** as a term', () => {
    const html = renderToStaticMarkup(<Rich text="Le `___` est un **embedding**" />);
    expect(html).toContain('class="ar-blank"');
    expect(html).toContain('<strong class="ar-term">embedding</strong>');
  });
  it('shows the word a sentence is about as found', () => {
    const html = renderToStaticMarkup(<Rich text="Le pigeon `vole`" mode="sentence" />);
    expect(html).toContain('<span class="ar-solved">vole</span>');
  });
});

describe('French typography', () => {
  it('ties high punctuation, units, « and digit groups to what they belong to', () => {
    expect(frenchSpaces('le rang : 10 000 mots ? 0,13 $ « oui »')).toBe(
      'le rang : 10 000 mots ? 0,13 $ « oui »',
    );
    expect(frenchSpaces('la 1 182e place, 19 900 duels')).toBe('la 1 182e place, 19 900 duels');
  });
  it('leaves no breakable space before a high punctuation mark in the French articles', () => {
    for (const [lang, , article] of articles) {
      if (lang !== 'fr') continue;
      for (const text of articleText(article)) expect(text, text).not.toMatch(/ [:;!?»]/);
    }
  });
});
