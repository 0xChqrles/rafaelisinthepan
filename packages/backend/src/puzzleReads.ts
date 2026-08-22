// The round route's artifact reads (#203). BOTH ARE FRESH — nothing here is cached, and the
// reason is worth the whole comment. (This module was `puzzleCache.ts` while it briefly held
// one; the name went with the cache, since a file called a cache that is not one misleads
// every later reader.)
//
//   | any append, any day | the SLICE         | read fresh, ~12.5 KB gzipped, 0.51 ms |
//   | a solve, any day    | the full artifact | read fresh, ~0.8 MB gzipped, 52 ms    |
//
// #203 designed a slice cache (~100 days resident) and a one-day cache for today's full
// artifact. Both are gone, and the reason they went is worth keeping: while the only identity
// in the system was the SENTENCE's hole layout, nothing could tell a cached artifact from a
// corrected one — and since rank 0 is a GROUP (79 of 151 hole occurrences in the local fr
// store carry more than one rank-0 key, worst 27), a correction moves exactly the aliases
// that decide `solved`. A stale slice then froze a round and recorded a score for a puzzle
// nobody solved, or silently swallowed a real solve, with nothing to correct either.
//
// The published `revision` (#203, user-decided 2026-08-22) would now make a cache safe — a
// version's content never changes, so an entry keyed by it can never go stale. It stays gone
// anyway, because fresh is simple and cheap enough not to need one: a ~12.5 KB GET plus a
// 0.51 ms parse per append, issued CONCURRENTLY with the round item's DynamoDB read
// (`rounds.ts`), so no wall-clock on a request already waiting on a comparable round trip,
// and on the order of $0.60 a month in S3 GETs at 1,000 players averaging 50 guesses.
//
// The megabytes the slice exists to avoid are still avoided: what #203 measured as unviable
// was PARSING a 6.21 MB artifact per append, and that is exactly what this never does. The
// full artifact is parsed once per round, on the append that solves it.

import type { Puzzle } from '@whippin/shared';
import type { PuzzleSlice } from './slice';
import type { PuzzleStore } from './store';

// The day's slice. Fetch it CONCURRENTLY with the round item's read (`rounds.ts` does):
// neither depends on the other, so the GET hides inside a round trip already being paid for.
//
// `revision` is the published VERSION the caller is playing. A stored slice describing
// another one is not this caller's to derive against, and answers null — the day-addressed
// 404 the route already has for a puzzle it cannot read.
export async function loadSlice(
  store: PuzzleStore,
  date: string,
  lang: string,
  revision: string,
): Promise<PuzzleSlice | null> {
  const slice = await store.getSlice(date, lang);
  return slice && slice.revision === revision ? slice : null;
}

// The FULL artifact — what the SCORE needs, because it counts unique tries and `guessKey`
// dedups on a guess's rank in EVERY map, not only the ranks near the answer. Loaded once per
// round, on the append that solves it.
export async function loadPuzzle(
  store: PuzzleStore,
  date: string,
  lang: string,
  revision: string,
): Promise<Puzzle | null> {
  const puzzle = await store.getPuzzle(date, lang);
  // A score counted off a retired version's maps is a score about a different puzzle.
  return puzzle && puzzle.revision === revision ? puzzle : null;
}
