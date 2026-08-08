// CONTRACT: the device-local play status derived from a persisted round (state/status.ts).
// Shared by the language selector and the archive (#55), so its behavior is pinned here
// after the extraction. Asserts the SPEC (none/solved/done/progress), not the
// implementation. A word run's status is read against the CLOCK (#163), never a stored
// flag, and its finished state is spoken DONE rather than solved.

import { describe, it, expect } from 'vitest';
import type { RuntimeHole } from '@whippin/shared';
import type { RoundProgress, WordRoundProgress } from './gameStore';
import { CLAIM_ZONE } from '../game/wordGame';
import { isComplete, statusOf, wordStatusOf, srStatus } from './status';

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

describe('wordStatusOf — Word mode (#163), off the round\'s clock', () => {
  const T0 = 1_700_000_000_000;
  const wordRound = (over: Partial<WordRoundProgress> = {}): WordRoundProgress => ({
    word: 'phare',
    startedAt: T0,
    deadline: T0 + 60_000,
    tried: [],
    claimed: 0,
    ...over,
  });

  it('none while the round is still at its rules gate', () => {
    expect(wordStatusOf(undefined, T0)).toEqual({ kind: 'none' });
    expect(wordStatusOf(wordRound({ startedAt: null, deadline: null }), T0)).toEqual({
      kind: 'none',
    });
  });

  it('a run past its deadline is DONE — finished, not solved', () => {
    // The distinction is the mode's: a timed-out run is over, and calling it solved would
    // claim an achievement Word mode does not have. Visually both are gold.
    expect(wordStatusOf(wordRound({ claimed: 7 }), T0 + 60_001)).toEqual({ kind: 'done' });
  });

  it('is read fresh against the CLOCK, so no stored flag can go stale', () => {
    const live = wordRound({ claimed: 25 });
    expect(wordStatusOf(live, T0 + 30_000).kind).toBe('progress');
    // Same round, same stored fields, later moment: the day is simply done. Nothing was
    // written in between — closing the tab cannot pause it.
    expect(wordStatusOf(live, T0 + 10_000_000)).toEqual({ kind: 'done' });
  });

  it('a live run is in progress at the claimed fraction of the zone', () => {
    // Anchored on the ZONE, never on the number it happens to hold (it went 150 -> 250 on
    // 2026-08-07): half the claimable zone reads 50%, all of it 100%. That is what "fraction
    // of the zone" means, and it survives the next retune without an edit here.
    expect(wordStatusOf(wordRound({ claimed: CLAIM_ZONE / 2 }), T0)).toEqual({
      kind: 'progress',
      pct: 50,
    });
    expect(wordStatusOf(wordRound({ claimed: CLAIM_ZONE }), T0)).toEqual({
      kind: 'progress',
      pct: 100,
    });
  });
});

describe('isComplete — what the VISUAL surfaces read', () => {
  it('is true for both finished states and nothing else', () => {
    // The strip and the calendar cell must not each restate the pair: a solved sentence
    // and a finished word run are one gold, and only the spoken status tells them apart.
    expect(isComplete({ kind: 'solved' })).toBe(true);
    expect(isComplete({ kind: 'done' })).toBe(true);
    expect(isComplete({ kind: 'progress', pct: 99 })).toBe(false);
    expect(isComplete({ kind: 'none' })).toBe(false);
  });
});

describe('srStatus — aria fragment', () => {
  it('names solved / done / percent / nothing, localized', () => {
    expect(srStatus('en', { kind: 'solved' })).toBe(' — solved');
    expect(srStatus('fr', { kind: 'solved' })).toBe(' — résolu');
    expect(srStatus('en', { kind: 'done' })).toBe(' — done');
    expect(srStatus('fr', { kind: 'done' })).toBe(' — terminé');
    expect(srStatus('en', { kind: 'progress', pct: 45 })).toBe(' — 45%');
    expect(srStatus('en', { kind: 'none' })).toBe('');
  });
});
