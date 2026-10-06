// CONTRACT: the play status a summary surface derives (state/status.ts). Shared by the
// archive (#55), so its behavior is pinned here. Asserts the SPEC (none/solved/over/progress),
// not the implementation. A status is read from the values the SERVER derives and stores
// beside the log (#203/#214) and its reading of whether the round is over — #211 is the read
// that supplies them.

import { describe, it, expect } from 'vitest';
import { statusOf, srStatus } from './status';

describe('statusOf — the server summary of a sentence round', () => {
  it('is "none" when no summary is known for the day', () => {
    // Nothing loaded yet, and no round on the server: both are "nothing to say", never a
    // claim that the day was not played.
    expect(statusOf(undefined)).toEqual({ kind: 'none' });
  });

  it('is "none" before any counted guess has moved the reconstruction', () => {
    expect(statusOf({ progress: 0, solved: false, over: false })).toEqual({ kind: 'none' });
  });

  it('is "solved" on the server\'s own solve, whatever the percentage says', () => {
    expect(statusOf({ progress: 100, solved: true, over: false })).toEqual({ kind: 'solved' });
    // `solved` is write-only-true and the stored percentage may lag a racing append, so
    // the flag WINS: a solved day must never paint as 62% because a settle is in flight.
    expect(statusOf({ progress: 62, solved: true, over: false })).toEqual({ kind: 'solved' });
  });

  it('is "progress" (rounded %) while the round is unsolved', () => {
    expect(statusOf({ progress: 41.7, solved: false, over: false })).toEqual({ kind: 'progress', pct: 42 });
  });

  it('is "over" for a round that ENDED UNSOLVED — given up or capped — whatever % it reached', () => {
    // The result, the share card and the board all print `∞` for it; the calendar must not
    // offer it as a day to resume. It carries no %: the day is over, not in progress.
    expect(statusOf({ progress: 93, solved: false, over: true })).toEqual({ kind: 'over' });
  });

  it('reads a give-up after only misses as "over", never as a day not started', () => {
    expect(statusOf({ progress: 0, solved: false, over: true })).toEqual({ kind: 'over' });
  });

  it('lets a solve win over the end', () => {
    expect(statusOf({ progress: 100, solved: true, over: true })).toEqual({ kind: 'solved' });
  });
});

describe('srStatus — aria fragment', () => {
  it('names solved / percent / unsolved / nothing, localized', () => {
    expect(srStatus('en', { kind: 'solved' })).toBe(' — solved');
    expect(srStatus('fr', { kind: 'solved' })).toBe(' — résolu');
    expect(srStatus('en', { kind: 'progress', pct: 45 })).toBe(' — 45%');
    expect(srStatus('en', { kind: 'over' })).toBe(' — unsolved');
    expect(srStatus('fr', { kind: 'over' })).toBe(' — non résolu');
    expect(srStatus('en', { kind: 'none' })).toBe('');
  });
});
