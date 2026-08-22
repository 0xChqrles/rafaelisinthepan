// CONTRACT (#203): the per-instance loading rule, three lines.
//
//   | any append, any day | the SLICE         | cached, ~100 days     |
//   | today               | the full artifact | cached — ONE day only |
//   | an archive solve    | the full artifact | loaded and DISCARDED  |
//
// Today's repeats and is worth holding; an archive day's is what would FILL an instance,
// which is the problem the slice exists to avoid. The full cache is swept against the
// server's own active day, or "today" quietly becomes "every day this instance has seen".
// A MISS is never cached — a day published slightly late must become playable without
// waiting for the instance to recycle.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { puzzleTag, type Puzzle } from '@whippin/shared';
import { loadPuzzle, loadSlice, resetArtifactCache } from './puzzleCache';
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

describe('the full artifact — today is cached, an archive day is not', () => {
  it('reads TODAY once and answers later solves from memory', async () => {
    const { store, getPuzzle } = countingStore();
    await loadPuzzle(store, TODAY, 'fr', TODAY, REV);
    await loadPuzzle(store, TODAY, 'fr', TODAY, REV);
    expect(getPuzzle).toHaveBeenCalledTimes(1);
  });

  it('LOADS AND DISCARDS an archive day, so browsing a month leaves nothing resident', async () => {
    const { store, getPuzzle } = countingStore();
    await loadPuzzle(store, '2026-07-01', 'fr', TODAY, REV);
    await loadPuzzle(store, '2026-07-01', 'fr', TODAY, REV);
    expect(getPuzzle).toHaveBeenCalledTimes(2);
  });

  it('drops the held day at the 22:00 flip, or "today" becomes every day it has seen', async () => {
    const { store, getPuzzle } = countingStore();
    await loadPuzzle(store, TODAY, 'fr', TODAY, REV);
    expect(getPuzzle).toHaveBeenCalledTimes(1);
    // The server's active day moves on: yesterday's entry is no longer today's.
    await loadPuzzle(store, '2026-08-22', 'fr', '2026-08-22', REV);
    expect(getPuzzle).toHaveBeenCalledTimes(2);
    // And the retired day is gone rather than lingering as a second resident artifact.
    await loadPuzzle(store, TODAY, 'fr', '2026-08-22', REV);
    expect(getPuzzle).toHaveBeenCalledTimes(3);
  });

  it('never caches a MISS here either', async () => {
    const { store, getPuzzle } = countingStore(false);
    expect(await loadPuzzle(store, TODAY, 'fr', TODAY, REV)).toBeNull();
    expect(await loadPuzzle(store, TODAY, 'fr', TODAY, REV)).toBeNull();
    expect(getPuzzle).toHaveBeenCalledTimes(2);
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

  it('binds the FULL artifact too — a score is counted off the maps of ONE puzzle', async () => {
    const first = countingStore(true, 'phare');
    expect(await loadPuzzle(first.store, TODAY, 'fr', TODAY, REV)).toBeTruthy();

    const second = countingStore(true, 'lampe');
    // The cached artifact describes the retired sentence: re-fetched rather than counted
    // against, since a score row is first-write-wins and permanent.
    expect(await loadPuzzle(second.store, TODAY, 'fr', TODAY, OTHER)).toBeTruthy();
    expect(second.getPuzzle).toHaveBeenCalledTimes(1);
    // And a caller on the retired revision gets nothing rather than the wrong maps.
    expect(await loadPuzzle(second.store, TODAY, 'fr', TODAY, REV)).toBeNull();
  });
});
