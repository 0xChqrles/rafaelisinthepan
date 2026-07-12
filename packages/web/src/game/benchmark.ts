import type { BenchmarkResults } from '@whippin/shared';

export interface BenchmarkRankingEntry {
  label: string;
  tries: number | null;
  player: boolean;
}

// Build the solved-screen race result. Modern JS sort is stable, so equal-scoring models
// retain the curator's puzzle order and the player (inserted last) follows tied models.
export function benchmarkRanking(
  entries: BenchmarkResults,
  playerTries: number,
  playerLabel: string,
): BenchmarkRankingEntry[] {
  return [
    ...entries.map(({ label, tries }) => ({ label, tries, player: false })),
    { label: playerLabel, tries: playerTries, player: true },
  ].sort((a, b) => {
    if (a.tries === null) return b.tries === null ? 0 : 1;
    if (b.tries === null) return -1;
    return a.tries - b.tries;
  });
}
