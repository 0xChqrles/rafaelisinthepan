import { describe, expect, it } from 'vitest';
import { MIN_POSSIBLE_SCORE, reactionFor, scoreBand } from './reactions';

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
});
