import { describe, expect, it } from 'vitest';
import { randomGlyphs, scrambleFrame } from './useScramble';

// The scramble is animation, but its length-interpolation math is real logic and the
// crux of issue #102's three scenarios: the locked prefix must never garble and the
// random tail count must never go negative, while the length walks old -> new.

const PS = [0, 0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999];

describe('scrambleFrame', () => {
  it('is exactly the target once settled (p >= 1)', () => {
    expect(scrambleFrame('forest', 3, 1)).toBe('forest');
    expect(scrambleFrame('forest', 9, 1.5)).toBe('forest');
    // Accented display forms are preserved verbatim at the landing.
    expect(scrambleFrame('forêt', 8, 1)).toBe('forêt');
  });

  it('locks the settled prefix left-to-right for every in-flight frame', () => {
    const target = 'forest';
    for (const p of PS) {
      const settled = Math.floor(p * target.length);
      const frame = scrambleFrame(target, target.length, p);
      // The first `settled` letters are the real target; nothing before them churns.
      expect(frame.slice(0, settled)).toBe(target.slice(0, settled));
    }
  });

  it('same length: width stays constant across the scramble', () => {
    const target = 'plant';
    for (const p of PS) {
      expect(scrambleFrame(target, target.length, p)).toHaveLength(target.length);
    }
  });

  it('longer target: width grows from the old length toward the new', () => {
    const target = 'wilderness'; // 10
    const fromLen = 4;
    let prev = fromLen;
    for (const p of PS) {
      const len = scrambleFrame(target, fromLen, p).length;
      expect(len).toBeGreaterThanOrEqual(fromLen);
      expect(len).toBeLessThanOrEqual(target.length);
      expect(len).toBeGreaterThanOrEqual(prev); // non-decreasing
      prev = len;
    }
    expect(scrambleFrame(target, fromLen, 1).length).toBe(target.length);
  });

  it('shorter target: width shrinks from the old length toward the new', () => {
    const target = 'oak'; // 3
    const fromLen = 11;
    let prev = fromLen;
    for (const p of PS) {
      const len = scrambleFrame(target, fromLen, p).length;
      expect(len).toBeLessThanOrEqual(fromLen);
      expect(len).toBeGreaterThanOrEqual(target.length);
      expect(len).toBeLessThanOrEqual(prev); // non-increasing
      prev = len;
    }
    expect(scrambleFrame(target, fromLen, 1)).toBe(target);
  });

  it('never emits a negative-length random tail (prefix fits within the width)', () => {
    // Stress a range of length changes; the frame length must always cover the prefix.
    for (const [target, fromLen] of [
      ['a', 20],
      ['abcdefghij', 1],
      ['sun', 3],
    ] as const) {
      for (const p of PS) {
        const settled = Math.floor(p * target.length);
        expect(scrambleFrame(target, fromLen, p).length).toBeGreaterThanOrEqual(settled);
      }
    }
  });
});

describe('randomGlyphs', () => {
  it('returns exactly n lowercase-latin glyphs', () => {
    expect(randomGlyphs(0)).toBe('');
    const g = randomGlyphs(50);
    expect(g).toHaveLength(50);
    expect(g).toMatch(/^[a-z]+$/);
  });
});
