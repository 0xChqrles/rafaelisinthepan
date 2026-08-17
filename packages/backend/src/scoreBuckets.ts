import {
  WORD_CLAIM_ZONE,
  type Puzzle,
  type ScoreHistogramBucket,
  type WordPuzzle,
} from '@whippin/shared';

export type ScoreMode = 'sentence' | 'word';

// The sentence score is the number of distinct, vocabulary-valid tries. These are the
// exact sizes of the two existence sets the client currently admits. A test reads the
// committed vocab assets and pins the values, so regenerating either set cannot silently
// make the backend reject a newly possible score.
export const SENTENCE_SCORE_MAX_BY_LANG: Readonly<Record<string, number>> = {
  en: 75_125,
  fr: 127_784,
};

// Word mode can claim at most the top 1,000 ranked groups. Kept server-side because it is
// a score-validation rule here; the histogram response carries the fixed ranges, so the
// follow-up web consumer does not need to duplicate the bucket edges.
export const WORD_SCORE_ZONE = WORD_CLAIM_ZONE;

// Inclusive upper edges, fixed per MODE. Sentence is lower-is-better and deliberately
// gives the competitive 3–60 range more resolution; Word is higher-is-better and gives
// zero its own DNF band. The final edge covers every score the supported corpora/mode can
// produce, so there is no overflow counter whose meaning could change later. Deriving only
// that terminal edge from the pinned corpus ceilings makes a future vocabulary growth extend
// the existing last band instead of silently rejecting scores or reinterpreting old counters.
const SENTENCE_UPPER_EDGES = [
  3,
  5,
  8,
  12,
  18,
  25,
  40,
  60,
  100,
  200,
  500,
  1_000,
  5_000,
  20_000,
  Math.max(...Object.values(SENTENCE_SCORE_MAX_BY_LANG)),
] as const;
const WORD_UPPER_EDGES = [0, 5, 10, 20, 35, 50, 75, 100, 150, 250, 400, 650, WORD_SCORE_ZONE] as const;

export interface ScoreRange {
  min: number;
  max: number;
}

export function scoreRanges(mode: ScoreMode): readonly ScoreRange[] {
  const edges = mode === 'word' ? WORD_UPPER_EDGES : SENTENCE_UPPER_EDGES;
  let min = mode === 'word' ? 0 : 1;
  return edges.map((max) => {
    const range = { min, max };
    min = max + 1;
    return range;
  });
}

export function scoreBucket(mode: ScoreMode, score: number): number | null {
  if (!Number.isInteger(score)) return null;
  const index = scoreRanges(mode).findIndex(({ min, max }) => score >= min && score <= max);
  return index < 0 ? null : index;
}

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

export function histogramBuckets(
  mode: ScoreMode,
  counts: readonly number[],
): ScoreHistogramBucket[] {
  return scoreRanges(mode).map(({ min, max }, index) => ({ min, max, count: counts[index] ?? 0 }));
}
