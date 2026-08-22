import { WORD_CLAIM_ZONE, type WordPuzzle } from '@whippin/shared';

export type ScoreMode = 'sentence' | 'word';

// Word mode can claim at most the top 1,000 ranked groups. Kept server-side because it
// is a validation rule here: it is what bounds the CLAIMS an end-of-run word log may hold.
export const WORD_SCORE_ZONE = WORD_CLAIM_ZONE;

// The SENTENCE ceiling is gone (#203). It existed to validate a score the CLIENT claimed —
// 1..the language's existence-set size — and there is no claimed score left: the server
// counts the unique tries in the log it stored (`shared`'s `countTries`), so the number
// cannot be out of range by construction. `VOCAB_BUILDS` is still the record that says
// which languages are supported and how long a stored guess may be (#200/#201); nothing
// reads a score ceiling from it any more.

export function wordScoreMaximum(puzzle: WordPuzzle): number {
  // Aliases repeat a group's rank, so count distinct claimable ranks, never raw keys.
  const ranks = new Set<number>();
  for (const entry of Object.values(puzzle.ranks)) {
    if (entry.rank >= 1 && entry.rank <= WORD_SCORE_ZONE) ranks.add(entry.rank);
  }
  return ranks.size;
}
