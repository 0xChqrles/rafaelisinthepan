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
import type { Puzzle } from '@whippin/shared';
import { loadPuzzle, loadSlice, resetArtifactCache } from './puzzleCache';
import { buildSlice } from './slice';
import type { PuzzleStore } from './store';

const TODAY = '2026-08-21';

function puzzleFor(date: string): Puzzle {
  return {
    lang: 'fr',
    words: [date],
    holes: [
      { pos: 0, secret: { word: 'phare', slug: 'phare' }, start: { word: 'quai', slug: 'quai' }, start_rank: 1 },
    ],
    ranks: { phare: { phare: { word: 'phare', rank: 0 }, quai: { word: 'quai', rank: 1 } } },
  };
}

function countingStore(present = true) {
  const getPuzzle = vi.fn(async (date: string) => (present ? puzzleFor(date) : null));
  const getSlice = vi.fn(async (date: string) => (present ? buildSlice(puzzleFor(date)) : null));
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
    await loadSlice(store, TODAY, 'fr');
    await loadSlice(store, TODAY, 'fr');
    await loadSlice(store, TODAY, 'fr');
    expect(getSlice).toHaveBeenCalledTimes(1);
    // A different day, and a different language of the same day, are different entries.
    await loadSlice(store, '2026-07-01', 'fr');
    await loadSlice(store, TODAY, 'en');
    expect(getSlice).toHaveBeenCalledTimes(3);
  });

  it('holds many archive days at once — that is what the slice is FOR', async () => {
    const { store, getSlice } = countingStore();
    const days = Array.from({ length: 60 }, (_, i) => `2026-06-${String((i % 30) + 1).padStart(2, '0')}`);
    for (const day of new Set(days)) await loadSlice(store, day, 'fr');
    const distinct = new Set(days).size;
    expect(getSlice).toHaveBeenCalledTimes(distinct);
    // All still resident.
    for (const day of new Set(days)) await loadSlice(store, day, 'fr');
    expect(getSlice).toHaveBeenCalledTimes(distinct);
  });

  it('never caches a MISS: a day published late becomes playable without a recycle', async () => {
    const { store, getSlice } = countingStore(false);
    expect(await loadSlice(store, TODAY, 'fr')).toBeNull();
    expect(await loadSlice(store, TODAY, 'fr')).toBeNull();
    expect(getSlice).toHaveBeenCalledTimes(2);
  });
});

describe('the full artifact — today is cached, an archive day is not', () => {
  it('reads TODAY once and answers later solves from memory', async () => {
    const { store, getPuzzle } = countingStore();
    await loadPuzzle(store, TODAY, 'fr', TODAY);
    await loadPuzzle(store, TODAY, 'fr', TODAY);
    expect(getPuzzle).toHaveBeenCalledTimes(1);
  });

  it('LOADS AND DISCARDS an archive day, so browsing a month leaves nothing resident', async () => {
    const { store, getPuzzle } = countingStore();
    await loadPuzzle(store, '2026-07-01', 'fr', TODAY);
    await loadPuzzle(store, '2026-07-01', 'fr', TODAY);
    expect(getPuzzle).toHaveBeenCalledTimes(2);
  });

  it('drops the held day at the 22:00 flip, or "today" becomes every day it has seen', async () => {
    const { store, getPuzzle } = countingStore();
    await loadPuzzle(store, TODAY, 'fr', TODAY);
    expect(getPuzzle).toHaveBeenCalledTimes(1);
    // The server's active day moves on: yesterday's entry is no longer today's.
    await loadPuzzle(store, '2026-08-22', 'fr', '2026-08-22');
    expect(getPuzzle).toHaveBeenCalledTimes(2);
    // And the retired day is gone rather than lingering as a second resident artifact.
    await loadPuzzle(store, TODAY, 'fr', '2026-08-22');
    expect(getPuzzle).toHaveBeenCalledTimes(3);
  });

  it('never caches a MISS here either', async () => {
    const { store, getPuzzle } = countingStore(false);
    expect(await loadPuzzle(store, TODAY, 'fr', TODAY)).toBeNull();
    expect(await loadPuzzle(store, TODAY, 'fr', TODAY)).toBeNull();
    expect(getPuzzle).toHaveBeenCalledTimes(2);
  });
});
