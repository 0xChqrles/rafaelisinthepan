import { VOCAB_BUILDS, WORD_CLAIM_ZONE, type Puzzle, type WordPuzzle } from '@whippin/shared';

export type ScoreMode = 'sentence' | 'word';

// Word mode can claim at most the top 1,000 ranked groups. Kept server-side because it
// is a score-validation rule here.
export const WORD_SCORE_ZONE = WORD_CLAIM_ZONE;

export function sentenceScoreMaximum(lang: string, _puzzle: Puzzle): number | null {
  // The sentence score is the number of distinct, vocabulary-valid tries, so the ceiling
  // is the size of the existence set the client admits — read from the GENERATED vocab
  // metadata (#200), which the same run that wrote the set produced. The two numbers used
  // to be copied here by hand behind a pinning test; regenerating a vocabulary now moves
  // this bound in the same commit, with nobody in the loop.
  //
  // Puzzle presence is significant even though that ceiling is per language: the handler
  // loads this day's artifact before accepting a score, so an unpublished daily never gets
  // a histogram. The unused argument makes that contract explicit at the callsite.
  //
  // `Object.hasOwn` and not an index read, the rule `vocab.ts` states and `liveRoute`'s
  // lang guard follows: a bare `VOCAB_BUILDS[lang]` walks the prototype chain, so a
  // `lang` of `constructor` or `toString` resolves to a function. It has no `vocabSize`
  // today, which is why `?.` held — but that is the shape of the value saving us, not
  // the lookup, and one map here answering a prototype key differently from the guard
  // that admitted the request is exactly the drift worth spelling out of existence.
  return Object.hasOwn(VOCAB_BUILDS, lang) ? VOCAB_BUILDS[lang].vocabSize : null;
}

export function wordScoreMaximum(puzzle: WordPuzzle): number {
  // Aliases repeat a group's rank, so count distinct claimable ranks, never raw keys.
  const ranks = new Set<number>();
  for (const entry of Object.values(puzzle.ranks)) {
    if (entry.rank >= 1 && entry.rank <= WORD_SCORE_ZONE) ranks.add(entry.rank);
  }
  return ranks.size;
}
