import type { Puzzle } from '@whippin/shared';

// Abstraction over wherever the day's puzzles live (S3 in prod, a fake in tests).
// `getPuzzle` returns null when no puzzle exists for that date+lang — that is a clean
// 404 at the edge, NOT an error/500. (The old `version()` — the #42 version-in-URL
// cache-busting — is gone: the puzzle URL is date-addressed now, and a republish
// invalidates the CDN instead of minting a new URL.)
export interface PuzzleStore {
  getPuzzle(date: string, lang: string): Promise<Puzzle | null>;
}
