// The round route's artifact reads (#203). BOTH ARE FRESH — there is no cache here any
// more, and the reason is worth the whole comment.
//
//   | any append, any day | the SLICE         | read fresh, ~12.5 KB gzipped, 0.51 ms |
//   | a solve, any day    | the full artifact | read fresh, ~0.8 MB gzipped, 52 ms    |
//
// #203 designed a slice cache (~100 days resident) and a one-day cache for today's full
// artifact. The full one went first, on review: the SCORE it feeds is a first-write-wins row
// that is never revisited, so it must not be derived from whatever an instance happens to be
// holding. The slice cache went next, and it went because of a fact the issue's design did
// not have:
//
//   **RANK 0 IS A GROUP, NOT A SLUG.** Every alias of the secret's group sits at rank 0 —
//   measured on the 51 fr puzzles in the local store, 79 of 151 hole occurrences have more
//   than one rank-0 input slug, and the worst has 27. A correction that re-runs the #104
//   merge walk moves aliases in and out of that group WITHOUT touching a hole, so the
//   revision tag below cannot see it.
//
// A stale slice therefore decides `solved` wrongly in BOTH directions, and neither heals:
//   - it holds an alias at rank 0 that the current artifact ranks 1. The server derives a
//     solve, FREEZES the round and records a permanent score row for a puzzle that is not
//     solved.
//   - it holds at rank 1 what the current artifact ranks 0. The server derives no solve — and
//     the client, whose own board says solved, has nothing left to append, so the "next
//     append corrects it" this file used to promise never happens. No freeze, no score, no
//     standing, forever.
// Both outcomes are permanent from a staleness bounded to minutes, which is the trade a cache
// was making without saying so. Validating only the SOLVE path against the fresh artifact
// fixes the first direction and cannot reach the second, since that path is never entered.
//
// So the slice is read every time. What that costs: one ~12.5 KB GET plus a 0.51 ms parse per
// append, issued CONCURRENTLY with the round item's DynamoDB read (`rounds.ts`) — so it adds
// no wall-clock to a request already waiting on a comparable round trip — and, at 1,000
// players averaging 50 guesses, on the order of $0.60 a month in S3 GETs. The megabytes the
// slice exists to avoid are still avoided: what #203 measured as unviable was PARSING a
// 6.21 MB artifact per append, and that is exactly what this still never does.

import { puzzleTag } from '@whippin/shared';
import type { Puzzle } from '@whippin/shared';
import type { PuzzleSlice } from './slice';
import type { PuzzleStore } from './store';

// The revision a PUZZLE describes — the same hole-layout tag the client computes from what
// it is playing, and the slice carries. It identifies the SENTENCE, never its rank maps:
// with the reads fresh that is all it has to do, which is the job it can actually hold.
export function revisionOf(puzzle: Puzzle): string {
  return puzzleTag(puzzle.holes.map((h) => ({ pos: h.pos, secret: h.secret.slug })));
}

// The day's slice. Fetch it CONCURRENTLY with the round item's read (`rounds.ts` does):
// neither depends on the other, so the GET hides inside a round trip already being paid for.
//
// `revision` is the sentence the CALLER is playing. A stored slice describing another one is
// not this caller's to derive against, and answers null — the day-addressed 404 the route
// already has for a puzzle it cannot read.
export async function loadSlice(
  store: PuzzleStore,
  date: string,
  lang: string,
  revision: string,
): Promise<PuzzleSlice | null> {
  const slice = await store.getSlice(date, lang);
  return slice && slice.puzzle === revision ? slice : null;
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
  // A score counted off a retired sentence's maps is a score about another puzzle.
  return puzzle && revisionOf(puzzle) === revision ? puzzle : null;
}
