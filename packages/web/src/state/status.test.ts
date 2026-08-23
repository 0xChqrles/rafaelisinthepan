// CONTRACT: the play status a summary surface derives (state/status.ts). Shared by the
// language selector and the archive (#55), so its behavior is pinned here. Asserts the
// SPEC (none/solved/done/progress), not the implementation. A SENTENCE status is now read
// from the two values the SERVER derives and stores beside the log (#203/#214) — #211 is
// the read that supplies them — while a word run's is read against the CLOCK (#163),
// never a stored flag, and its finished state is spoken DONE rather than solved.

import { describe, it, expect } from 'vitest';
import type { WordRoundProgress } from './gameStore';
import { CLAIM_ZONE } from '../game/wordGame';
import { isComplete, statusOf, wordStatusOf, srStatus } from './status';

describe('statusOf — the server summary of a sentence round', () => {
  it('is "none" when no summary is known for the day', () => {
    // Nothing loaded yet, and no round on the server: both are "nothing to say", never a
    // claim that the day was not played.
    expect(statusOf(undefined)).toEqual({ kind: 'none' });
  });

  it('is "none" before any counted guess has moved the reconstruction', () => {
    expect(statusOf({ progress: 0, solved: false })).toEqual({ kind: 'none' });
  });

  it('is "solved" on the server\'s own solve, whatever the percentage says', () => {
    expect(statusOf({ progress: 100, solved: true })).toEqual({ kind: 'solved' });
    // `solved` is write-only-true and the stored percentage may lag a racing append, so
    // the flag WINS: a solved day must never paint as 62% because a settle is in flight.
    expect(statusOf({ progress: 62, solved: true })).toEqual({ kind: 'solved' });
  });

  it('is "progress" (rounded %) while the round is unsolved', () => {
    expect(statusOf({ progress: 41.7, solved: false })).toEqual({ kind: 'progress', pct: 42 });
  });

  it('keeps a CAPPED round on its reconstruction percentage, never solved gold', () => {
    // #214: the cap changes the RESULT's headline to `∞`; the day itself is an unsolved
    // round that reached 93%, and that is what a summary surface shows.
    expect(statusOf({ progress: 93, solved: false })).toEqual({ kind: 'progress', pct: 93 });
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
    // Over means STRICTLY after: at the deadline's own millisecond the run is still in
    // play — the store still takes a guess there, and this must not already say done.
    expect(wordStatusOf(wordRound({ claimed: 7 }), T0 + 60_000).kind).toBe('progress');
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
