// Per-INSTANCE artifact caching for the round route (#203). Deriving a round's state from
// its stored log needs the day's puzzle, and /round serves any archive day, so what a warm
// Lambda may hold resident is the whole question. The loading rule is three lines:
//
//   | any append, any day | the SLICE         | cached, ~100 days       |
//   | today               | the full artifact | cached — ONE day only   |
//   | an archive solve    | the full artifact | loaded and DISCARDED    |
//
// TODAY'S IS CACHED BECAUSE IT IS THE ONLY ONE THAT REPEATS. Nearly all traffic is the
// active daily, so one instance holds one day's artifact per language and most appends
// parse nothing. AN ARCHIVE SOLVE LOADS AND DISCARDS: it happens once per round and archive
// play is rare, so 42-54 ms once is fine — but caching it is what FILLS an instance, which
// is the problem the slice exists to avoid. Browsing a month of the archive must not leave
// a month of artifacts resident.
//
// Measured (node, the worst fr puzzle in the local store, `2026-07-25.fr.json`): the full
// artifact is 6.21 MB raw / 52.3 ms to gunzip+parse / 16.6 MB retained; its slice is
// 66.7 KB / 0.51 ms / 0.22 MB. So per warm Lambda, against its 512 MB: today's fr artifact
// 18 MB (worst of 49), the slice cache ~14 MB, ~32 MB steady for one language and ~50 MB
// while an archive solve is in flight. About a sixteenth of the instance.
//
// The full cache is keyed by DATE and swept against the SERVER's own active day, or
// "today" quietly becomes "every day this instance has seen".
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

import type { Puzzle } from '@whippin/shared';
import type { PuzzleSlice } from './slice';
import type { PuzzleStore } from './store';

// ~100 days at 0.22 MB retained each. The slice is what makes this bound affordable at all:
// at 12-18 MB an artifact, a handful of archive days is already uncomfortable.
const MAX_CACHED_SLICES = 100;

const slices = new Map<string, PuzzleSlice>();
// At most one entry per language — the ACTIVE day's — swept whenever the day moves.
const puzzles = new Map<string, Puzzle>();

const cacheKey = (date: string, lang: string) => `${date}|${lang}`;

// The day's slice, cached across appends. Fetch it CONCURRENTLY with the round item's read
// (`rounds.ts` does): neither depends on the other, so a cache miss hides inside a round
// trip that is being paid for anyway.
export async function loadSlice(
  store: PuzzleStore,
  date: string,
  lang: string,
): Promise<PuzzleSlice | null> {
  const key = cacheKey(date, lang);
  const cached = slices.get(key);
  if (cached) {
    // Re-insert so Map's insertion order is a true LRU.
    slices.delete(key);
    slices.set(key, cached);
    return cached;
  }
  const slice = await store.getSlice(date, lang);
  if (!slice) return null;
  slices.set(key, slice);
  // Evict the least recently used entries down to the bound.
  for (const oldest of slices.keys()) {
    if (slices.size <= MAX_CACHED_SLICES) break;
    slices.delete(oldest);
  }
  return slice;
}

// The FULL artifact — what the score needs, because it counts unique tries and `guessKey`
// dedups on a guess's rank in EVERY map, not only the ranks near the answer. Held for the
// active day and no other.
export async function loadPuzzle(
  store: PuzzleStore,
  date: string,
  lang: string,
  serverDate: string,
): Promise<Puzzle | null> {
  // The 22:00 flip: yesterday's entry stops being "today's" the moment the server's active
  // day moves, and holding it is how the one-day cache turns into an unbounded one.
  for (const key of [...puzzles.keys()]) {
    if (!key.startsWith(`${serverDate}|`)) puzzles.delete(key);
  }
  const active = date === serverDate;
  const key = cacheKey(date, lang);
  if (active) {
    const cached = puzzles.get(key);
    if (cached) return cached;
  }
  const puzzle = await store.getPuzzle(date, lang);
  if (puzzle && active) puzzles.set(key, puzzle);
  return puzzle;
}

// Test seam: module state must not leak between tests (and a store swapped under a warm
// process must not answer from another store's artifacts).
export function resetArtifactCache(): void {
  slices.clear();
  puzzles.clear();
}
