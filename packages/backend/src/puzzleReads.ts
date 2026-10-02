// The artifact reads (#203): the derivation SLICE, read FRESH on every append, and the FULL
// artifact, held in the Lambda's memory KEYED BY ITS PUBLISHED REVISION.
//
//   | any append, any day                    | the SLICE         | read fresh, ~12.5 KB gzipped |
//   | a solve, the day board, the live read  | the full artifact | reused for the same          |
//   |                                        |                   | revision, else read fresh    |
//
// The FULL artifact (~0.8 MB gzipped, a 6.21 MB JSON parse) is what an exact try count
// needs, and the live ranking reads it at guess cadence: every player in a group re-reads
// the board after their own guesses land, against an API limited to 10 concurrent Lambdas.
// Parsing it per read would spend those slots on the same megabytes over and over, so a
// warm Lambda KEEPS the parsed artifact and reuses it — but only for the revision the
// caller has just learned is current.
//
// Why a revision makes this safe: a published version's content never changes (the
// revision is a hash of the whole artifact, rank maps included), so an entry keyed by it can
// never go stale. A correction mints a new revision and simply misses. The current revision
// is always learned FRESH: from the slice the append just read (a solve — the round's own
// tag, which that slice was checked against), or from a fresh slice read (`loadCurrentPuzzle`
// — the boards). A full artifact read fresh is kept only when it names that revision; one
// that does not is the day-addressed 404 (the publish writes the slice first, so the window
// between the two writes fails closed rather than mixing them).
//
// The memory is per STORE INSTANCE (one per Lambda container in production, one per test
// handler), at most `HELD_ARTIFACTS` entries by store key — the active day in each language —
// the least recently used one evicted.

import type { Puzzle } from '@whippin/shared';
import { storeKey } from './layout';
import type { PuzzleSlice } from './slice';
import type { PuzzleStore } from './store';

export const HELD_ARTIFACTS = 2;

const held = new WeakMap<PuzzleStore, Map<string, Puzzle>>();

function heldFor(store: PuzzleStore): Map<string, Puzzle> {
  let entries = held.get(store);
  if (!entries) {
    entries = new Map();
    held.set(store, entries);
  }
  return entries;
}

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

// The FULL artifact of the published `revision` — what the SCORE needs, because it counts
// unique tries and `guessKey` dedups on a guess's rank in EVERY map, not only the ranks near
// the answer. Null when the store holds another version (a count off a retired version's
// maps is a count about a different puzzle) or none.
export async function loadPuzzle(
  store: PuzzleStore,
  date: string,
  lang: string,
  revision: string,
): Promise<Puzzle | null> {
  const key = storeKey(date, lang);
  const entries = heldFor(store);
  const kept = entries.get(key);
  if (kept && kept.revision === revision) {
    // Touched: the entry moves to the back of the eviction order.
    entries.delete(key);
    entries.set(key, kept);
    return kept;
  }
  const puzzle = await store.getPuzzle(date, lang);
  if (!puzzle || puzzle.revision !== revision) return null;
  entries.delete(key);
  entries.set(key, puzzle);
  while (entries.size > HELD_ARTIFACTS) entries.delete(entries.keys().next().value as string);
  return puzzle;
}

// The FULL artifact of whatever version is published NOW: the slice, read fresh, names it.
// Null for an unpublished day (no slice), and for the publish window where the two objects
// disagree. The boards read through this — a board has no revision of its own to ask about.
export async function loadCurrentPuzzle(
  store: PuzzleStore,
  date: string,
  lang: string,
): Promise<Puzzle | null> {
  const slice = await store.getSlice(date, lang);
  return slice ? loadPuzzle(store, date, lang, slice.revision) : null;
}
