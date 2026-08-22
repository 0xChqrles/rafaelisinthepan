// Per-INSTANCE artifact loading for the round route (#203). Deriving a round's state from
// its stored log needs the day's puzzle, and /round serves any archive day, so what a warm
// Lambda may hold resident is the whole question.
//
//   | any append, any day | the SLICE         | cached, ~100 days, ~5 min fresh |
//   | a solve, any day    | the full artifact | loaded and DISCARDED           |
//
// THE SPLIT IS ABOUT WHAT THE VALUE COSTS IF IT IS WRONG (settled on review, replacing a
// "today's artifact is cached for one day" rule). The slice feeds `progress`, which the next
// append recomputes, and `solved`, which a rank correction can barely move — rank 0 is the
// secret's own slug in every revision of the same sentence, so a stale slice cannot invent a
// solve out of a different word; only a correction that DROPS a rank-0 alias could, and only
// for a player who typed that alias inside the window. Both self-heal or are bounded by it,
// so the cache is what makes an append cheap and the staleness is affordable. The FULL artifact feeds the
// SCORE — one first-write-wins row, permanent, and never revisited — so it is read fresh,
// every time, and the cache that used to hold it is gone. That costs one 52 ms parse per
// SOLVE, on a path that has just done a DynamoDB write and is once per round; it buys the
// one number nobody can correct afterwards. (When #206 wants a live per-append count, the
// cache comes back with whatever freshness that number needs — the slice's rule below is the
// template.)
//
// Measured (node, the worst fr puzzle in the local store, `2026-07-25.fr.json`): the full
// artifact is 6.21 MB raw / 52.3 ms to gunzip+parse / 16.6 MB retained; its slice is
// 66.7 KB / 0.51 ms / 0.22 MB. So a warm Lambda now holds ~14 MB of slices against its
// 512 MB, with the artifact resident only for the moment a solve is being scored.
//
// **A REPUBLISH HAS TO REACH A WARM INSTANCE, and two things carry it** — neither alone is
// enough, which is what review found:
//   - the slice NAMES THE SENTENCE it describes (`puzzle`, the hole-layout tag the client
//     computes and the server stores beside a round). A caller who has already loaded the
//     corrected daily carries the new tag, so a cached slice of the old one is detected and
//     re-fetched IMMEDIATELY. What it cannot see is a correction that leaves the holes
//     alone — the tag is a sentence's identity, not its rank maps' — so it is only half.
//   - a FRESHNESS WINDOW does the rest. Nothing invalidates a Lambda's own memory, so
//     without one a corrected daily is derived against the retired ranks for as long as the
//     instance lives. `SLICE_MAX_AGE_MS` matches the browser `max-age` the puzzle route
//     serves, so the origin's derivation becomes correct on the same timescale the player's
//     own copy does.
//
// A MISS is never cached. A day published slightly late must become playable without
// waiting for the instance to recycle, exactly as the puzzle route's short negative TTL
// intends at the edge.
//
// The slice fetch sits BEFORE the round-start challenge (it has to: the pre-read that says
// whether a challenge is even owed is the other half of the same `Promise.all`), so an
// unauthenticated caller can walk past dates and evict hot entries. Left alone deliberately:
// what that buys them is one ~12 KB GET and a 0.5 ms parse on somebody's next append, and
// the same caller can already pull the whole 6 MB artifact for any past day off the puzzle
// route — cheaper for them and dearer for us. Gating first would cost every honest append
// its concurrency to bound nothing.

import { puzzleTag } from '@whippin/shared';
import type { Puzzle } from '@whippin/shared';
import type { PuzzleSlice } from './slice';
import type { PuzzleStore } from './store';

// ~100 days at 0.22 MB retained each.
const MAX_CACHED_SLICES = 100;

// How long a cached slice may answer before it is read again. The puzzle route serves
// `max-age=300` to browsers, so this is the same window a player's own copy of a corrected
// daily takes to arrive.
export const SLICE_MAX_AGE_MS = 300_000;

interface CachedSlice {
  slice: PuzzleSlice;
  fetchedAt: number;
}

const slices = new Map<string, CachedSlice>();

const cacheKey = (date: string, lang: string) => `${date}|${lang}`;

// The revision a PUZZLE describes — the same hole-layout tag the client computes from what
// it is playing, and the slice carries.
export function revisionOf(puzzle: Puzzle): string {
  return puzzleTag(puzzle.holes.map((h) => ({ pos: h.pos, secret: h.secret.slug })));
}

// Evict the least recently used entries down to the bound. Runs on EVERY path that inserts
// — a mismatched fetch is still an insert, and returning before this let 101 mismatched
// loads sit resident past a 100-entry limit (found on review).
function evictSlices(): void {
  for (const oldest of slices.keys()) {
    if (slices.size <= MAX_CACHED_SLICES) break;
    slices.delete(oldest);
  }
}

// The day's slice, cached across appends. Fetch it CONCURRENTLY with the round item's read
// (`rounds.ts` does): neither depends on the other, so a cache miss hides inside a round
// trip that is being paid for anyway.
//
// `revision` is the sentence the CALLER is playing. A stored slice describing another one is
// not this caller's to derive against, and answers null — the day-addressed 404 the route
// already has for a puzzle it cannot read.
export async function loadSlice(
  store: PuzzleStore,
  date: string,
  lang: string,
  revision: string,
  now: number = Date.now(),
): Promise<PuzzleSlice | null> {
  const key = cacheKey(date, lang);
  const cached = slices.get(key);
  // Both conditions, not just the tag: matching the caller proves the entry is about the
  // right SENTENCE, never that it is the store's current copy of it.
  if (cached && cached.slice.puzzle === revision && now - cached.fetchedAt < SLICE_MAX_AGE_MS) {
    // Re-insert so Map's insertion order is a true LRU.
    slices.delete(key);
    slices.set(key, cached);
    return cached.slice;
  }
  const slice = await store.getSlice(date, lang);
  if (!slice) {
    // A day whose slice has gone is not a day to keep answering for.
    slices.delete(key);
    return null;
  }
  slices.set(key, { slice, fetchedAt: now });
  evictSlices();
  // The store's own copy describes a different sentence: this caller is on a retired
  // revision, which the route answers as the missing puzzle it is.
  return slice.puzzle === revision ? slice : null;
}

// The FULL artifact — what the SCORE needs, because it counts unique tries and `guessKey`
// dedups on a guess's rank in EVERY map, not only the ranks near the answer.
//
// READ FRESH, ALWAYS. It is loaded once per round, on the append that solves it, and what it
// produces is a first-write-wins row that is never revisited — so it is the one value in
// this file that must not be derived from anything an instance happens to be holding.
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

// Test seam: module state must not leak between tests (and a store swapped under a warm
// process must not answer from another store's artifacts).
export function resetArtifactCache(): void {
  slices.clear();
}
