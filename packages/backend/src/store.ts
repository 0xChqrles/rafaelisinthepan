import type { Puzzle } from '@whippin/shared';

// Abstraction over wherever the day's puzzles live (S3 in prod, a fake in tests).
// `getPuzzle` returns null when no puzzle exists for that date+lang — that is a clean
// 404 at the edge, NOT an error/500.
export interface PuzzleStore {
  getPuzzle(date: string, lang: string): Promise<Puzzle | null>;
}
