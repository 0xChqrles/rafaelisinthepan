// The result's count size (`countSize.ts`): whether SHARE stays on the screen.
import { describe, expect, it } from 'vitest';
import { COUNT_EM, COUNT_ROWS, inkEms } from '@whippin/shared';
import { COUNT_MAX_PX, COUNT_MAX_WIDE_PX, COUNT_MIN_PX, countSize } from './countSize';

describe('countSize — the count at a whole scale', () => {
  // A height that never binds.
  const TALL = 10_000;

  it('is always a whole multiple of 8px, inside its floor and ceiling', () => {
    for (let width = 100; width <= 700; width += 7) {
      for (const height of [20, 90, 140, 400, TALL]) {
        for (const digits of [1, 2, 3]) {
          const size = countSize(width, height, inkEms(digits), false);
          expect(size % 8).toBe(0);
          expect(size).toBeGreaterThanOrEqual(COUNT_MIN_PX);
          expect(size).toBeLessThanOrEqual(COUNT_MAX_PX);
        }
      }
    }
  });

  it('fits its ink in the hero: three digits at 320 (a 260px hero) take 88px', () => {
    const size = countSize(260, TALL, inkEms(3), false);
    expect(size).toBe(88);
    expect(size * inkEms(3)).toBeLessThanOrEqual(260);
    expect((size + 8) * inkEms(3)).toBeGreaterThan(260);
  });

  it('fits its box in the height the card spares it: the cap height, 7/8 of the size', () => {
    // A short desktop window: a wide column, 137px left for the count's box.
    const size = countSize(616, 137, inkEms(2), true);
    expect(size).toBe(152);
    expect((size * COUNT_ROWS) / COUNT_EM).toBeLessThanOrEqual(137);
    expect(((size + 8) * COUNT_ROWS) / COUNT_EM).toBeGreaterThan(137);
    // A phone the same.
    expect(countSize(330, 112, inkEms(2), false)).toBe(128);
  });

  it('caps a phone at the share card\'s 160, the desktop at 192', () => {
    expect(countSize(330, TALL, inkEms(2), false)).toBe(COUNT_MAX_PX);
    expect(countSize(616, TALL, inkEms(2), true)).toBe(COUNT_MAX_WIDE_PX);
  });

  it('never goes under the floor, even when nothing fits', () => {
    expect(countSize(40, TALL, inkEms(3), false)).toBe(COUNT_MIN_PX);
    expect(countSize(616, 10, inkEms(2), true)).toBe(COUNT_MIN_PX);
  });

});
