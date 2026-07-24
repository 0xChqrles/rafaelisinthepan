import { fold } from '@whippin/shared';
import type { Puzzle, RuntimeHole } from '@whippin/shared';
import { computeProgress, guessKey } from './scoring';

export interface BenchmarkReplayOutcome {
  holeIndex: number;
  rank: number | null;
  word: string | null;
  improved: boolean;
  solved: boolean;
}

export interface BenchmarkReplayStep {
  word: string;
  slug: string;
  tryNumber: number;
  outcomes: BenchmarkReplayOutcome[];
  progress: number;
}

export interface BenchmarkReplayResult {
  tries: number;
  solved: boolean;
  holes: RuntimeHole[];
  steps: BenchmarkReplayStep[];
}

// Replay a benchmark's already-vocabulary-validated counted guesses through the same
// canonical-identity dedupe (guessKey — an inflection of an already-counted word never
// counts, #104), per-unsolved-hole lookup, and strict-improvement rules as Game. Rank-map
// membership cannot decide validity because a real vocabulary word may MISS every hole;
// therefore every non-empty unique run item counts, including all-cold guesses.
export function replayRun(
  puzzle: Pick<Puzzle, 'holes' | 'ranks'>,
  run: readonly string[],
): BenchmarkReplayResult {
  let holes: RuntimeHole[] = puzzle.holes.map((hole) => ({
    pos: hole.pos,
    secret: hole.secret.slug,
    word: hole.start.word,
    rank: hole.start_rank,
    startRank: hole.start_rank,
  }));
  const triedKeys = new Set<string>();
  const steps: BenchmarkReplayStep[] = [];

  for (const word of run) {
    const typed = fold(word);
    if (!typed) continue;
    const key = guessKey(puzzle.ranks, typed);
    if (triedKeys.has(key)) continue;
    triedKeys.add(key);

    const outcomes: BenchmarkReplayOutcome[] = [];
    holes = holes.map((hole, holeIndex) => {
      if (hole.rank === 0) return hole;

      const entry = puzzle.ranks[hole.secret][typed];
      if (entry == null) {
        outcomes.push({
          holeIndex,
          rank: null,
          word: null,
          improved: false,
          solved: false,
        });
        return hole;
      }

      const improved = entry.rank < hole.rank;
      outcomes.push({
        holeIndex,
        rank: entry.rank,
        word: entry.word,
        improved,
        solved: improved && entry.rank === 0,
      });
      return improved ? { ...hole, word: entry.word, rank: entry.rank } : hole;
    });

    steps.push({
      word,
      slug: typed,
      tryNumber: triedKeys.size,
      outcomes,
      progress: computeProgress(holes, puzzle.ranks),
    });
  }

  return {
    tries: triedKeys.size,
    solved: holes.every((hole) => hole.rank === 0),
    holes,
    steps,
  };
}
