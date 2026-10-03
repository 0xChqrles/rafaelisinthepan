// CONTRACT: the SLICE is read FRESH on every append; the FULL artifact is held in memory
// KEYED BY ITS PUBLISHED REVISION, and the revision a caller asks for is always one it has
// just learned fresh (the append's slice, or `loadCurrentPuzzle`'s own slice read).
//
//   | any append, any day                    | the SLICE         | read fresh                 |
//   | a solve, the day board, the live read  | the full artifact | reused for the same        |
//   |                                        |                   | revision, else read fresh  |
//
// A published version's content never changes, so an entry keyed by it never goes stale; a
// correction is a new revision and misses. RANK 0 IS A GROUP, so a correction can move solve
// aliases without touching a hole — which is exactly what the revision (and nothing about the
// sentence) captures.

import { describe, expect, it, vi } from 'vitest';
import type { Puzzle } from '@whippin/shared';
import { HELD_ARTIFACTS, loadCurrentPuzzle, loadPuzzle, loadSlice } from './puzzleReads';
import { buildSlice } from './slice';
import type { PuzzleStore } from './store';

const TODAY = '2026-08-21';

function puzzleFor(date: string, secret = 'phare', aliasRank = 0, revision = REV): Puzzle {
  return {
    lang: 'fr',
    revision,
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

const REV = 'a1b2c3d4e5f60718';
const CORRECTED = 'b2c3d4e5f6071829';

// A store whose published version can be REPLACED under a live reader, as a republish does.
function countingStore(present = true, secret = 'phare', aliasRank = 0, revision = REV) {
  const published = { aliasRank, revision, present };
  const getPuzzle = vi.fn(async (date: string) =>
    published.present ? puzzleFor(date, secret, published.aliasRank, published.revision) : null,
  );
  const getSlice = vi.fn(async (date: string) =>
    published.present ? buildSlice(puzzleFor(date, secret, published.aliasRank, published.revision)) : null,
  );
  const store: PuzzleStore = {
    getPuzzle,
    hasPuzzle: async () => published.present,
    getSlice,
  };
  return { store, getPuzzle, getSlice, published };
}

describe('the slice is read FRESH', () => {
  it('reads the slice on every append, today and archive alike', async () => {
    const { store, getSlice } = countingStore();
    await loadSlice(store, TODAY, 'fr', REV);
    await loadSlice(store, TODAY, 'fr', REV);
    await loadSlice(store, '2026-07-01', 'fr', REV);
    expect(getSlice).toHaveBeenCalledTimes(3);
  });

  // The whole reason the revision exists. A correction that re-runs the merge walk moves a
  // rank-0 alias without touching a hole — invisible to any identity derived from the
  // sentence, and decisive for `solved`.
  it('sees a correction that moves a rank-0 ALIAS without touching a hole', async () => {
    const before = countingStore(true, 'phare', 0);
    expect((await loadSlice(before.store, TODAY, 'fr', REV))?.holes.phare.ranks.phares).toBe(0);

    // Same sentence, same holes — a NEW published version, so a caller on the old one is
    // refused rather than derived against the corrected maps.
    const after = countingStore(true, 'phare', 1, CORRECTED);
    expect(await loadSlice(after.store, TODAY, 'fr', REV)).toBeNull();
    expect((await loadSlice(after.store, TODAY, 'fr', CORRECTED))?.holes.phare.ranks.phares).toBe(1);
  });
});

describe('the full artifact is held by REVISION', () => {
  it('reads it once for the same revision, and reuses the parsed artifact after', async () => {
    const { store, getPuzzle } = countingStore();
    const first = await loadPuzzle(store, TODAY, 'fr', REV);
    const second = await loadPuzzle(store, TODAY, 'fr', REV);
    expect(getPuzzle).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('MISSES on a republish: a new revision reads the new artifact fresh', async () => {
    const { store, getPuzzle, published } = countingStore();
    expect((await loadPuzzle(store, TODAY, 'fr', REV))?.ranks.phare.phares.rank).toBe(0);
    // The correction moves the alias; the caller learned the new revision from a fresh slice.
    published.aliasRank = 1;
    published.revision = CORRECTED;
    const corrected = await loadPuzzle(store, TODAY, 'fr', CORRECTED);
    expect(getPuzzle).toHaveBeenCalledTimes(2);
    expect(corrected?.revision).toBe(CORRECTED);
    expect(corrected?.ranks.phare.phares.rank).toBe(1);
    // …and the retired version is never answered again, held or not.
    expect(await loadPuzzle(store, TODAY, 'fr', REV)).toBeNull();
  });

  it('keeps two store keys apart: one day never answers for another, nor one language', async () => {
    const { store, getPuzzle } = countingStore();
    const today = await loadPuzzle(store, TODAY, 'fr', REV);
    const yesterday = await loadPuzzle(store, '2026-08-20', 'fr', REV);
    expect(today?.words).toEqual([TODAY]);
    expect(yesterday?.words).toEqual(['2026-08-20']);
    expect(getPuzzle).toHaveBeenCalledTimes(2);
    // Both held: asking again reads nothing.
    await loadPuzzle(store, TODAY, 'fr', REV);
    await loadPuzzle(store, '2026-08-20', 'fr', REV);
    expect(getPuzzle).toHaveBeenCalledTimes(2);
  });

  it(`holds at most ${HELD_ARTIFACTS} artifacts, evicting the least recently used`, async () => {
    const { store, getPuzzle } = countingStore();
    await loadPuzzle(store, '2026-08-19', 'fr', REV);
    await loadPuzzle(store, '2026-08-20', 'fr', REV);
    await loadPuzzle(store, '2026-08-19', 'fr', REV); // touched: 08-20 is now the oldest
    await loadPuzzle(store, TODAY, 'fr', REV); // evicts 08-20
    expect(getPuzzle).toHaveBeenCalledTimes(3);
    await loadPuzzle(store, '2026-08-19', 'fr', REV);
    expect(getPuzzle).toHaveBeenCalledTimes(3);
    await loadPuzzle(store, '2026-08-20', 'fr', REV);
    expect(getPuzzle).toHaveBeenCalledTimes(4);
  });

  it('keeps one store instance\'s memory to itself', async () => {
    const a = countingStore();
    const b = countingStore(true, 'lampe');
    await loadPuzzle(a.store, TODAY, 'fr', REV);
    expect(Object.keys((await loadPuzzle(b.store, TODAY, 'fr', REV))!.ranks)).toEqual(['lampe']);
    expect(b.getPuzzle).toHaveBeenCalledTimes(1);
  });

  // The store's publish writes the slice FIRST: for that moment the fresh slice names a
  // revision the full artifact does not carry yet, and the read fails closed.
  it('answers NULL when the full artifact does not carry the asked revision, and holds nothing', async () => {
    const { store, getPuzzle } = countingStore(true, 'phare', 0, CORRECTED);
    expect(await loadPuzzle(store, TODAY, 'fr', REV)).toBeNull();
    expect(await loadPuzzle(store, TODAY, 'fr', REV)).toBeNull();
    expect(getPuzzle).toHaveBeenCalledTimes(2);
  });
});

describe('the CURRENT artifact: the slice names the revision', () => {
  it('reads the slice fresh each time and the full artifact once per revision', async () => {
    const { store, getPuzzle, getSlice, published } = countingStore();
    expect((await loadCurrentPuzzle(store, TODAY, 'fr'))?.revision).toBe(REV);
    expect((await loadCurrentPuzzle(store, TODAY, 'fr'))?.revision).toBe(REV);
    expect(getSlice).toHaveBeenCalledTimes(2);
    expect(getPuzzle).toHaveBeenCalledTimes(1);
    // A republish: the next fresh slice names the new revision, which misses.
    published.revision = CORRECTED;
    expect((await loadCurrentPuzzle(store, TODAY, 'fr'))?.revision).toBe(CORRECTED);
    expect(getPuzzle).toHaveBeenCalledTimes(2);
  });

  it('answers NULL for an unpublished day without reading the full artifact', async () => {
    const { store, getPuzzle } = countingStore(false);
    expect(await loadCurrentPuzzle(store, TODAY, 'fr')).toBeNull();
    expect(getPuzzle).not.toHaveBeenCalled();
  });
});

describe('the version — is this caller playing the puzzle the store holds?', () => {
  const OTHER = 'c3d4e5f607182930';

  it('answers NULL for a caller on a version the store has replaced', async () => {
    // The route turns this into the day-addressed 404, which is the honest answer for a
    // puzzle that is gone.
    const { store } = countingStore(true, 'lampe', 0, OTHER);
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
