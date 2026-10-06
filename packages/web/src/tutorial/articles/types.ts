// THE ARTICLE LEVELS' DOCUMENT SHAPE (levels 2+, 2026-09-29). An article is data, per
// language, like the privacy notice and the level-1 scripts: prose whose structure is part of
// what it says, so it lives in its own module (`fr.ts`, …) and never in `i18n.ts`.
//
// INLINE MARKUP, in every string below (`Rich.tsx` renders it):
//   `mot`      a word as the game shows one — the pixel face, on the held chip's white ground
//   `mot^12`   the same word wearing its rank, the heat-coloured exponent of the sentence
//   `mot^0`    the secret itself, SOLVED — the game's cobalt ink, as a found word reads
//   `___`      a hidden word: an empty hole
//   **terme**  a term being defined
//   [texte](https://…)  a link out (https only), opened in a new tab
export interface PlanePoint {
  word: string;
  x: number; // plane units, 0–6 on both axes
  y: number;
  // A point that is the figure's subject (drawn in the accent).
  focus?: boolean;
  // Where its word stands: above the square (the default) or below it, clear of an edge.
  label?: 'above' | 'below';
}

export interface WordList {
  // The list's name on the figure's switch (with `tabs`).
  label?: string;
  words: string[];
  // Words the figure points at: the WRONG sense (the weird red end of the heat ramp) or the
  // RIGHT one (its calm cobalt end).
  marked?: string[];
  tone?: 'wrong' | 'right';
}

export type Figure =
  // Words as points on a plane, with the distance printed on each edge. With `tabs`, one
  // state per tab (the same words, moved), toggled like the article's AVANT / APRÈS.
  | { kind: 'plane'; states: PlanePoint[][]; edges: [number, number][]; tabs?: string[] }
  // Probabilities, as bars.
  | { kind: 'bars'; rows: [string, number][] }
  // A loop of steps, lit one after another, that starts over.
  | { kind: 'loop'; steps: string[] }
  // Lists of words, one under the other — or, with `tabs`, one list per tab.
  | { kind: 'words'; sentence?: string; lists: WordList[]; tabs?: boolean }
  // Attention: arcs from the `focus` token to the others, weighted; `weights[i]` is the share
  // token i receives (null: no arc), `hidden` the tokens the focus cannot hear yet.
  | { kind: 'arcs'; tokens: string[]; focus: number; weights: (number | null)[]; hidden?: number[] }
  // Two pipelines, step by step; `marked` steps are where they differ.
  | { kind: 'flow'; rows: { name: string; steps: string[]; marked?: number[] }[] }
  // The top of a real tournament, drawn as a climb: each word's place by its grade (`from`),
  // the place the tournament gives it (`to`, else its row's), its mean win probability. `heads`
  // are the drawing's one-line heads, `labels` the same columns named in full for the table
  // screen readers get — both in the order from, to, win.
  | {
      kind: 'tournament';
      rows: { word: string; from: number; win: number; to?: number }[];
      heads: [string, string, string];
      labels: [string, string, string];
    };

export type Block =
  | { p: string }
  | { quote: string }
  // An example sentence (one per line), its words of interest marked with backticks.
  | { sentence: string[] }
  // Text the machine is given, verbatim (a rubric, a prompt).
  | { code: string[] }
  | { terms: [string, string][] }
  | { steps: string[] }
  | { fig: Figure; caption: string };

export interface ArticleSection {
  heading?: string;
  blocks: Block[];
}

export interface Article {
  sections: ArticleSection[];
  // The last line, after everything: a quiet footnote (a source, a link).
  source?: { text: string; href: string };
}
