import type { Puzzle } from '@whippin/shared';
import type { PuzzleSlice } from './slice';

// Abstraction over wherever the day's puzzles live (S3 in prod, a fake in tests).
// `getPuzzle` returns null when no puzzle exists for that date+lang — that is a clean
// 404 at the edge, NOT an error/500.
//
// `getSlice` is #203's derivation slice: the small object `puzzle:publish` writes beside a
// puzzle, holding just enough of its rank maps to say what a stored guess log has
// reached. A MISSING slice IS a missing puzzle — the same day-addressed 404 — because there
// is no degraded mode: either publishing failed or the day was never published, and both
// are the same answer.
export interface PuzzleStore {
  getPuzzle(date: string, lang: string): Promise<Puzzle | null>;
  getSlice(date: string, lang: string): Promise<PuzzleSlice | null>;
}

// A missing object surfaces as NoSuchKey / NotFound (or a bare 404 status) — for a READ
// (s3Store) and for the existence probe (`inventory`) alike. It lives here rather than in
// s3Store because that module imports the S3 SDK eagerly, and `inventory` must stay
// AWS-free until it actually talks to S3.
export function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
}
