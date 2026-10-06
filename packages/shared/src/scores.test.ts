// CONTRACT: a round ENDS UNSOLVED when the player gave up or the stored raw log holds the
// cap — and a solve wins over both (root AGENTS.md, Sentence round). The rule has two input
// shapes — the round's state (`roundEnded`) and its three facts (`endedUnsolved`, the month
// read's) — and they are ONE reading: held equal here over every combination.

import { describe, expect, it } from 'vitest';
import { ROUND_GUESS_CAP, endedUnsolved, roundEnded } from './scores';

const log = (n: number) => Array.from({ length: n }, (_, i) => `g${i}`);

describe('roundEnded', () => {
  it('is false for a round still being played, and for one whose state has not arrived', () => {
    expect(roundEnded({ solved: false, gaveUp: false, guesses: log(3) })).toBe(false);
    expect(roundEnded({ guesses: [] })).toBe(false);
    expect(roundEnded(null)).toBe(false);
    expect(roundEnded(undefined)).toBe(false);
  });

  it('ends a round the player GAVE UP, whatever its length', () => {
    expect(roundEnded({ solved: false, gaveUp: true, guesses: log(1) })).toBe(true);
  });

  it('ends a round whose raw log holds the cap', () => {
    expect(roundEnded({ solved: false, guesses: log(ROUND_GUESS_CAP) })).toBe(true);
    expect(roundEnded({ solved: false, guesses: log(ROUND_GUESS_CAP - 1) })).toBe(false);
  });

  it('lets a SOLVE win over a give-up and over the cap', () => {
    expect(roundEnded({ solved: true, gaveUp: true, guesses: log(2) })).toBe(false);
    expect(roundEnded({ solved: true, guesses: log(ROUND_GUESS_CAP) })).toBe(false);
  });
});

describe('endedUnsolved — the same rule over its three facts', () => {
  it('ends on a give-up alone, or on the cap alone; neither is a round still open', () => {
    expect(endedUnsolved({ solved: false, gaveUp: true, capped: false })).toBe(true);
    expect(endedUnsolved({ solved: false, gaveUp: false, capped: true })).toBe(true);
    expect(endedUnsolved({ solved: false, gaveUp: true, capped: true })).toBe(true);
    expect(endedUnsolved({ solved: false, gaveUp: false, capped: false })).toBe(false);
  });

  it('lets a solve win over a give-up and over the cap', () => {
    expect(endedUnsolved({ solved: true, gaveUp: true, capped: false })).toBe(false);
    expect(endedUnsolved({ solved: true, gaveUp: false, capped: true })).toBe(false);
    expect(endedUnsolved({ solved: true, gaveUp: true, capped: true })).toBe(false);
    expect(endedUnsolved({ solved: true, gaveUp: false, capped: false })).toBe(false);
  });

  it('agrees with roundEnded on every round: the cap is the raw log at ROUND_GUESS_CAP', () => {
    for (const length of [0, 1, ROUND_GUESS_CAP - 1, ROUND_GUESS_CAP]) {
      for (const solved of [false, true]) {
        for (const gaveUp of [false, true]) {
          const guesses = log(length);
          expect(roundEnded({ solved, gaveUp, guesses }), `${length} ${solved} ${gaveUp}`).toBe(
            endedUnsolved({ solved, gaveUp, capped: guesses.length >= ROUND_GUESS_CAP }),
          );
        }
      }
    }
  });

  it('the month read can learn the cap from ONE entry: the last slot under it is filled exactly at the cap', () => {
    // The store probes `guesses[ROUND_GUESS_CAP - 1]` instead of reading the log: an element
    // there means the log holds the cap (the append never lets it grow past).
    expect(log(ROUND_GUESS_CAP)[ROUND_GUESS_CAP - 1]).toBeDefined();
    expect(log(ROUND_GUESS_CAP - 1)[ROUND_GUESS_CAP - 1]).toBeUndefined();
  });
});
