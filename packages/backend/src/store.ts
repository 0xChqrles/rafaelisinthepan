import type { Puzzle } from '@whippin/shared';

// Abstraction over wherever the day's puzzles live (S3 in prod, a fake in tests).
// `getPuzzle` returns null when no puzzle exists for that date+lang — that is a clean
// 404 at the edge, NOT an error/500.
export interface PuzzleStore {
  getPuzzle(date: string, lang: string): Promise<Puzzle | null>;
  // A CONTENT version of the (date, lang) puzzle — a token that changes iff the stored
  // bytes change (issue #42). It drives the version-in-URL cache-busting: the front reads
  // it from /today and requests /?lang=&v=<version>, so a corrected puzzle lives at a new
  // URL (guaranteed CDN + browser miss) instead of waiting out a stale long-TTL entry.
  // The value is opaque (S3 ETag = the object's MD5 for our single-part SSE-S3 uploads;
  // the local mirror computes the same MD5 over the file). null when no puzzle exists.
  version(date: string, lang: string): Promise<string | null>;
}
