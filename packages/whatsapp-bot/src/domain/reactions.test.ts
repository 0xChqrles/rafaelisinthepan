import { describe, expect, it } from 'vitest';
import { MIN_POSSIBLE_SCORE, reactionFor, reactionForShare, scoreBand, verdictOf, wordBand } from './reactions';

describe('how good a result was (#236)', () => {
  it('treats THREE as the floor: perfect, not merely good', () => {
    // A sentence hides three words, so three tries is the least anyone can spend. Nothing
    // beats it, which is why it is its own band rather than the top of a "good" one.
    expect(MIN_POSSIBLE_SCORE).toBe(3);
    expect(scoreBand(3, false)).toBe('perfect');
    expect(scoreBand(4, false)).toBe('brilliant');
  });

  it('keeps everything under ten in the good half', () => {
    for (const score of [4, 5, 6, 7, 8, 9]) {
      expect(['brilliant', 'strong']).toContain(scoreBand(score, false));
    }
    expect(scoreBand(10, false)).toBe('ordinary');
    expect(scoreBand(19, false)).toBe('ordinary');
    expect(scoreBand(20, false)).toBe('laboured');
  });

  it('a run that never finished is failed, whatever number rode with it', () => {
    expect(scoreBand(3, true)).toBe('failed');
    expect(scoreBand(500, true)).toBe('failed');
    expect(reactionFor(3, true)).toBe('💀');
  });

  it('gives every band one emoji, and the emoji follows the band', () => {
    const seen = [3, 5, 8, 12, 30].map((s) => reactionFor(s, false));
    expect(new Set(seen).size).toBe(seen.length); // no two bands share a face
    expect(reactionFor(3, false)).toBe('💯');
  });

  it("grades a WORD run on its own ladder — more is better, no floor, no cap, no 'failed'", () => {
    // Cut on the recorded French scores of 2026-08-28 → 09-04: median ~10, upper quartile
    // ~17, a handful over 30, the best 58.
    expect(wordBand(0)).toBe('laboured');
    expect(wordBand(7)).toBe('laboured');
    expect(wordBand(8)).toBe('ordinary');
    expect(wordBand(14)).toBe('ordinary');
    expect(wordBand(15)).toBe('strong');
    expect(wordBand(25)).toBe('brilliant');
    expect(wordBand(40)).toBe('perfect');
    expect(wordBand(58)).toBe('perfect');
    expect(verdictOf({ mode: 'word', player: 'x', claims: 26 })).toBe('brilliant');
    expect(verdictOf({ mode: 'sentence', player: 'x', score: 26, capped: false })).toBe('laboured');
    // One emoji map for both dailies.
    expect(reactionForShare({ mode: 'word', player: 'x', claims: 40 })).toBe(reactionFor(3, false));
  });
});
