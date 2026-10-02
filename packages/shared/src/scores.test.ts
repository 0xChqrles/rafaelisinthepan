// CONTRACT: a round ENDS UNSOLVED when the player gave up or the stored raw log holds the
// cap — and a solve wins over both (root AGENTS.md, Sentence round).

import { describe, expect, it } from 'vitest';
import { ROUND_GUESS_CAP, roundEnded } from './scores';

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
