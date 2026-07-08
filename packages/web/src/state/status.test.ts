// CONTRACT: the device-local play status derived from a persisted round (state/status.ts).
// Shared by the language selector and the archive (#55), so its behavior is pinned here
// after the extraction. Asserts the SPEC (none/solved/progress), not the implementation.

import { describe, it, expect } from 'vitest';
import type { RuntimeHole } from '@whippin/shared';
import type { RoundProgress } from './gameStore';
import { statusOf, srStatus } from './status';

const hole = (rank: number): RuntimeHole => ({
  pos: 1,
  secret: 's',
  word: 'w',
  rank,
  startRank: 100,
});

const round = (over: Partial<RoundProgress>): RoundProgress => ({
  holes: [hole(0)],
  guessCount: 0,
  tried: [],
  progress: 0,
  ...over,
});

describe('statusOf', () => {
  it('is "none" with no round or before any counted guess', () => {
    expect(statusOf(undefined)).toEqual({ kind: 'none' });
    expect(statusOf(round({ guessCount: 0 }))).toEqual({ kind: 'none' });
  });

  it('is "solved" when every hole is discovered (rank 0)', () => {
    expect(statusOf(round({ guessCount: 5, holes: [hole(0), hole(0)] }))).toEqual({
      kind: 'solved',
    });
  });

  it('is "progress" (rounded %) while some hole is unsolved', () => {
    expect(
      statusOf(round({ guessCount: 3, holes: [hole(0), hole(12)], progress: 41.7 })),
    ).toEqual({ kind: 'progress', pct: 42 });
  });

  it('is not "solved" for a round with zero holes', () => {
    // guessCount>0 but no holes -> the every() over [] must not read as solved.
    expect(statusOf(round({ guessCount: 1, holes: [], progress: 0 }))).toEqual({
      kind: 'progress',
      pct: 0,
    });
  });
});

describe('srStatus — aria fragment', () => {
  it('names solved / percent / nothing, localized', () => {
    expect(srStatus('en', { kind: 'solved' })).toBe(' — solved');
    expect(srStatus('fr', { kind: 'solved' })).toBe(' — résolu');
    expect(srStatus('en', { kind: 'progress', pct: 45 })).toBe(' — 45%');
    expect(srStatus('en', { kind: 'none' })).toBe('');
  });
});
