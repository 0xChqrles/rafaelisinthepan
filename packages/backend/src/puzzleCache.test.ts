// CONTRACT (#203): the per-instance loading rule, three lines.
//
//   | any append, any day | the SLICE         | cached, ~100 days, ~5 min fresh |
//   | a solve, any day    | the full artifact | loaded and DISCARDED           |
//
// The split is about what the value COSTS IF IT IS WRONG: the slice feeds `progress` (the
// next append recomputes it) and `solved` (rank 0 is the secret in every revision of one
// sentence), so bounded staleness is safe. The FULL artifact feeds the SCORE — one
// first-write-wins row, permanent, never revisited — so it is read fresh, every time.
//
// A republish has to reach a warm instance, and TWO things carry it: the slice names the
// SENTENCE it describes, so a caller already on the corrected daily is detected at once; and
// a freshness window covers the rest, since a correction that leaves the holes alone changes
// no tag. A MISS is never cached — a day published slightly late must become playable
// without waiting for the instance to recycle.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { puzzleTag, type Puzzle } from '@whippin/shared';
import { loadPuzzle, loadSlice, resetArtifactCache, SLICE_MAX_AGE_MS } from './puzzleCache';
import { buildSlice } from './slice';
import type { PuzzleStore } from './store';

const TODAY = '2026-08-21';

function puzzleFor(date: string, secret = 'phare'): Puzzle {
  return {
    lang: 'fr',
    words: [date],
    holes: [
      { pos: 0, secret: { word: secret, slug: secret }, start: { word: 'quai', slug: 'quai' }, start_rank: 1 },
    ],
    ranks: { [secret]: { [secret]: { word: secret, rank: 0 }, quai: { word: 'quai', rank: 1 } } },
  };
}

// The revision every caller in this file is playing, unless it says otherwise.
const REV = puzzleTag([{ pos: 0, secret: 'phare' }]);

function countingStore(present = true, secret = 'phare') {
  const getPuzzle = vi.fn(async (date: string) => (present ? puzzleFor(date, secret) : null));
  const getSlice = vi.fn(async (date: string) =>
    present ? buildSlice(puzzleFor(date, secret)) : null,
  );
  const store: PuzzleStore = {
    getPuzzle,
    async getWordPuzzle() {
      return null;
    },
    getSlice,
  };
  return { store, getPuzzle, getSlice };
}

beforeEach(() => {
  resetArtifactCache();
});

describe('the slice cache — every append, every day', () => {
  it('reads the store once per (date, lang) and answers the rest from memory', async () => {
    const { store, getSlice } = countingStore();
    await loadSlice(store, TODAY, 'fr', REV);
    await loadSlice(store, TODAY, 'fr', REV);
    await loadSlice(store, TODAY, 'fr', REV);
    expect(getSlice).toHaveBeenCalledTimes(1);
    // A different day, and a different language of the same day, are different entries.
    await loadSlice(store, '2026-07-01', 'fr', REV);
    await loadSlice(store, TODAY, 'en', REV);
    expect(getSlice).toHaveBeenCalledTimes(3);
  });

  it('holds many archive days at once — that is what the slice is FOR', async () => {
    const { store, getSlice } = countingStore();
    const days = Array.from({ length: 60 }, (_, i) => `2026-06-${String((i % 30) + 1).padStart(2, '0')}`);
    for (const day of new Set(days)) await loadSlice(store, day, 'fr', REV);
    const distinct = new Set(days).size;
    expect(getSlice).toHaveBeenCalledTimes(distinct);
    // All still resident.
    for (const day of new Set(days)) await loadSlice(store, day, 'fr', REV);
    expect(getSlice).toHaveBeenCalledTimes(distinct);
  });

  it('never caches a MISS: a day published late becomes playable without a recycle', async () => {
    const { store, getSlice } = countingStore(false);
    expect(await loadSlice(store, TODAY, 'fr', REV)).toBeNull();
    expect(await loadSlice(store, TODAY, 'fr', REV)).toBeNull();
    expect(getSlice).toHaveBeenCalledTimes(2);
  });
});

describe('the full artifact — never cached, because the SCORE is permanent', () => {
  it('reads the store EVERY time, today included', async () => {
    // It is loaded once per round, on the append that solves it, and what it produces is a
    // first-write-wins row nobody revisits. 52 ms on that path buys the one number that
    // cannot be corrected afterwards.
    const { store, getPuzzle } = countingStore();
    await loadPuzzle(store, TODAY, 'fr', REV);
    await loadPuzzle(store, TODAY, 'fr', REV);
    await loadPuzzle(store, '2026-07-01', 'fr', REV);
    expect(getPuzzle).toHaveBeenCalledTimes(3);
  });

  it('answers NULL for a caller on a revision the store has replaced', async () => {
    const { store } = countingStore(true, 'lampe');
    expect(await loadPuzzle(store, TODAY, 'fr', REV)).toBeNull();
  });

  it('answers NULL for an unpublished day', async () => {
    const { store } = countingStore(false);
    expect(await loadPuzzle(store, TODAY, 'fr', REV)).toBeNull();
  });
});

// CONTRACT (#203, added on review): a cached artifact is bound to the REVISION it describes.
// Keyed by date and language alone, a warm instance keeps deriving the sentence published
// this morning for as long as it lives — there is no TTL and no invalidation reaching in
// here, so a republished daily would be scored against the retired one's ranks indefinitely.
describe('revision binding — a republish must not be served from a warm cache', () => {
  const OTHER = puzzleTag([{ pos: 0, secret: 'lampe' }]);

  it('re-fetches a SLICE whose revision no longer matches, and serves the new one', async () => {
    const first = countingStore(true, 'phare');
    expect(await loadSlice(first.store, TODAY, 'fr', REV)).toBeTruthy();
    expect(first.getSlice).toHaveBeenCalledTimes(1);

    // The daily is republished under a live instance: the caller is on the new revision, the
    // cache holds the old one.
    const second = countingStore(true, 'lampe');
    const fresh = await loadSlice(second.store, TODAY, 'fr', OTHER);
    expect(second.getSlice).toHaveBeenCalledTimes(1);
    expect(fresh?.puzzle).toBe(OTHER);
    // …and the new one is then cached in its place.
    expect(await loadSlice(second.store, TODAY, 'fr', OTHER)).toBeTruthy();
    expect(second.getSlice).toHaveBeenCalledTimes(1);
  });

  it('answers NULL for a caller on a revision the store has replaced', async () => {
    // Not a stale cache — a client still holding the retired sentence. The route turns this
    // into the day-addressed 404, which is the honest answer for a puzzle that is gone.
    const { store } = countingStore(true, 'lampe');
    expect(await loadSlice(store, TODAY, 'fr', REV)).toBeNull();
  });

  it('REVALIDATES a stale entry even for a caller whose tag still matches it', async () => {
    // The tag only detects "caller ahead of cache". A caller still on the OLD sentence
    // matches the OLD cached slice, so nothing ever re-reads — which is how a republish
    // failed to reach a warm instance at all (found on review). The freshness window is
    // what covers it, and it is also the only thing that covers a correction leaving the
    // holes alone, since that changes no tag.
    const first = countingStore(true, 'phare');
    const t0 = 1_000_000;
    expect(await loadSlice(first.store, TODAY, 'fr', REV, t0)).toBeTruthy();
    // Inside the window, the held copy answers.
    expect(await loadSlice(first.store, TODAY, 'fr', REV, t0 + SLICE_MAX_AGE_MS - 1)).toBeTruthy();
    expect(first.getSlice).toHaveBeenCalledTimes(1);
    // Past it, the store is asked again — which is what lets a republish land.
    await loadSlice(first.store, TODAY, 'fr', REV, t0 + SLICE_MAX_AGE_MS);
    expect(first.getSlice).toHaveBeenCalledTimes(2);
  });

  it('bounds the cache on a MISMATCHED load too, not only a matching one', async () => {
    // The mismatch path inserts and returns; returning before the eviction let 101
    // mismatched loads sit resident past a 100-entry limit (found on review).
    const { store } = countingStore(true, 'lampe');
    for (let i = 0; i < 130; i += 1) {
      const day = `2026-03-${String((i % 28) + 1).padStart(2, '0')}`;
      expect(await loadSlice(store, day, `l${i}`, REV)).toBeNull();
    }
    // Every one of those was a mismatch; the map is still bounded.
    const { store: fresh, getSlice } = countingStore(true, 'phare');
    await loadSlice(fresh, TODAY, 'fr', REV);
    expect(getSlice).toHaveBeenCalledTimes(1);
  });

  it('binds the FULL artifact too — a score is counted off the maps of ONE puzzle', async () => {
    const { store } = countingStore(true, 'lampe');
    // A caller on the retired revision gets nothing rather than the wrong maps.
    expect(await loadPuzzle(store, TODAY, 'fr', REV)).toBeNull();
    expect(await loadPuzzle(store, TODAY, 'fr', OTHER)).toBeTruthy();
  });
});
