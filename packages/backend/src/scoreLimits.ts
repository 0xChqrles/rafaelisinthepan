import { WORD_CLAIM_ZONE, type Puzzle, type WordPuzzle } from '@whippin/shared';

export type ScoreMode = 'sentence' | 'word';

// The sentence score is the number of distinct, vocabulary-valid tries. These are the
// exact sizes of the two existence sets the client currently admits. A test reads the
// committed vocab assets and pins the values, so regenerating either set cannot silently
// make the backend reject a newly possible score.
export const SENTENCE_SCORE_MAX_BY_LANG: Readonly<Record<string, number>> = {
  en: 75_125,
  fr: 127_784,
};

// Word mode can claim at most the top 1,000 ranked groups. Kept server-side because it
// is a score-validation rule here.
export const WORD_SCORE_ZONE = WORD_CLAIM_ZONE;

export function sentenceScoreMaximum(lang: string, _puzzle: Puzzle): number | null {
  // Puzzle presence is significant even though the existence-set ceiling is per language:
  // the handler loads this day's artifact before accepting a score, so an unpublished daily
  // never gets a histogram. The unused argument makes that contract explicit at the callsite.
  return SENTENCE_SCORE_MAX_BY_LANG[lang] ?? null;
}

export function wordScoreMaximum(puzzle: WordPuzzle): number {
  // Aliases repeat a group's rank, so count distinct claimable ranks, never raw keys.
  const ranks = new Set<number>();
  for (const entry of Object.values(puzzle.ranks)) {
    if (entry.rank >= 1 && entry.rank <= WORD_SCORE_ZONE) ranks.add(entry.rank);
  }
  return ranks.size;
}
