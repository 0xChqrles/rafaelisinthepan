// CONTRACT (#203, settled over two review rounds): the round route reads BOTH artifacts
// FRESH, and neither is cached.
//
//   | any append, any day | the SLICE         | read fresh |
//   | a solve, any day    | the full artifact | read fresh |
//
// The issue designed a slice cache and a one-day cache for today's artifact. The full one
// went first — the SCORE it feeds is a first-write-wins row nobody revisits. The slice cache
// went because RANK 0 IS A GROUP: every alias of the secret's group sits at rank 0 (79 of
// 151 hole occurrences in the local fr store, worst 27), and a correction that re-runs the
// #104 merge walk moves aliases in and out of it WITHOUT touching a hole — so the revision
// tag cannot see it, and a stale slice decides `solved` wrongly in both directions, neither
// of which heals. What survives is the tag, whose honest job is "is this caller playing the
// sentence the store holds?".

import { describe, expect, it, vi } from 'vitest';
import { puzzleTag, type Puzzle } from '@whippin/shared';
import { loadPuzzle, loadSlice, revisionOf } from './puzzleCache';
import { buildSlice } from './slice';
import type { PuzzleStore } from './store';

const TODAY = '2026-08-21';

function puzzleFor(date: string, secret = 'phare', aliasRank = 0): Puzzle {
  return {
    lang: 'fr',
    words: [date],
    holes: [
      { pos: 0, secret: { word: secret, slug: secret }, start: { word: 'quai', slug: 'quai' }, start_rank: 2 },
    ],
    ranks: {
      [secret]: {
        [secret]: { word: secret, rank: 0 },
        // The ALIAS whose rank a correction moves without touching a hole.
        [`${secret}s`]: { word: secret, rank: aliasRank },
        quai: { word: 'quai', rank: 2 },
      },
    },
  };
}

const REV = puzzleTag([{ pos: 0, secret: 'phare' }]);

function countingStore(present = true, secret = 'phare', aliasRank = 0) {
  const getPuzzle = vi.fn(async (date: string) =>
    present ? puzzleFor(date, secret, aliasRank) : null,
  );
  const getSlice = vi.fn(async (date: string) =>
    present ? buildSlice(puzzleFor(date, secret, aliasRank)) : null,
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

describe('both artifacts are read FRESH', () => {
  it('reads the slice on every append, today and archive alike', async () => {
    const { store, getSlice } = countingStore();
    await loadSlice(store, TODAY, 'fr', REV);
    await loadSlice(store, TODAY, 'fr', REV);
    await loadSlice(store, '2026-07-01', 'fr', REV);
    expect(getSlice).toHaveBeenCalledTimes(3);
  });

  it('reads the full artifact on every solve', async () => {
    const { store, getPuzzle } = countingStore();
    await loadPuzzle(store, TODAY, 'fr', REV);
    await loadPuzzle(store, TODAY, 'fr', REV);
    expect(getPuzzle).toHaveBeenCalledTimes(2);
  });

  // The whole reason the cache went. A held slice cannot answer with an alias set the store
  // has since changed, because there is nothing held to answer with.
  it('sees a correction that moves a rank-0 ALIAS without touching a hole', async () => {
    const before = countingStore(true, 'phare', 0);
    expect((await loadSlice(before.store, TODAY, 'fr', REV))?.holes.phare.ranks.phares).toBe(0);

    // Same sentence, same holes, same tag — only the group changed.
    const after = countingStore(true, 'phare', 1);
    expect(revisionOf(puzzleFor(TODAY, 'phare', 1))).toBe(REV);
    expect((await loadSlice(after.store, TODAY, 'fr', REV))?.holes.phare.ranks.phares).toBe(1);
  });
});

describe('the revision tag — is this caller playing the sentence the store holds?', () => {
  const OTHER = puzzleTag([{ pos: 0, secret: 'lampe' }]);

  it('answers NULL for a caller on a sentence the store has replaced', async () => {
    // The route turns this into the day-addressed 404, which is the honest answer for a
    // puzzle that is gone.
    const { store } = countingStore(true, 'lampe');
    expect(await loadSlice(store, TODAY, 'fr', REV)).toBeNull();
    expect(await loadPuzzle(store, TODAY, 'fr', REV)).toBeNull();
    // …and serves the caller who IS on it.
    expect(await loadSlice(store, TODAY, 'fr', OTHER)).toBeTruthy();
    expect(await loadPuzzle(store, TODAY, 'fr', OTHER)).toBeTruthy();
  });

  it('answers NULL for an unpublished day', async () => {
    const { store } = countingStore(false);
    expect(await loadSlice(store, TODAY, 'fr', REV)).toBeNull();
    expect(await loadPuzzle(store, TODAY, 'fr', REV)).toBeNull();
  });
});
