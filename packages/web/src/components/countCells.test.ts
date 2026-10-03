// The result's count as cells (`countCells.ts`): its size decides whether SHARE stays on the
// screen, and its layout whether the canvas draws exactly the face's glyphs where the
// DOM text sets them.
import { describe, expect, it } from 'vitest';
import {
  COUNT_EM,
  COUNT_MAX_PX,
  COUNT_MAX_WIDE_PX,
  COUNT_MIN_PX,
  COUNT_ROWS,
  capCorners,
  countInk,
  countSize,
  glyphBoxes,
  inkEms,
  REEL_ROWS,
  reelInk,
  reelRow,
} from './countCells';
import type { DigitMask } from './digitMasks';

// Two synthetic glyphs on the 7-row band: a "1" two columns wide (ink at column 1 only, a
// cap at the top), a "7" seven wide (a full top row).
const ONE: DigitMask = {
  w: 2,
  rows: Uint8Array.from([1, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]),
};
const SEVEN: DigitMask = {
  w: 7,
  rows: Uint8Array.from([
    ...[1, 1, 1, 1, 1, 1, 1],
    ...Array.from({ length: 6 * 7 }, (_, i) => (i % 7 === 6 ? 1 : 0)),
  ]),
};
const masks: DigitMask[] = [];
masks[1] = ONE;
masks[7] = SEVEN;

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

  it('measures the ink: every advance but the last glyph\'s trailing blank column', () => {
    expect(inkEms(1)).toBe(7 / 8);
    expect(inkEms(3)).toBe(3 - 1 / 8);
  });
});

describe('countInk — the face\'s glyphs on its own 8-pixel advance', () => {
  it('sets glyph i at i em, its mask\'s column x at the face\'s column x', () => {
    const ink = countInk(masks, '71');
    // The 7's top row runs its whole width…
    for (let x = 0; x < 7; x += 1) expect(ink(x, 0)).toBe(true);
    // …and its advance's eighth column is blank.
    expect(ink(7, 0)).toBe(false);
    // The 1 starts at the next em.
    expect(ink(COUNT_EM + 0, 0)).toBe(true);
    expect(ink(COUNT_EM + 1, 3)).toBe(true);
    expect(ink(COUNT_EM + 0, 3)).toBe(false);
  });

  it('is blank off the band, off the string and on a glyph it does not know', () => {
    const ink = countInk(masks, '17');
    expect(ink(-1, 0)).toBe(false);
    expect(ink(0, -1)).toBe(false);
    expect(ink(0, 7)).toBe(false);
    expect(ink(2 * COUNT_EM, 0)).toBe(false);
    expect(countInk(masks, '0')(0, 0)).toBe(false);
  });
});

describe('reelInk — the count\'s reels on the same grid', () => {
  // Every cell of the band for `slots` glyph slots, as a string to compare.
  const band = (ink: (gx: number, gy: number) => boolean, slots: number) =>
    Array.from({ length: COUNT_ROWS }, (_, gy) =>
      Array.from({ length: slots * COUNT_EM }, (_, gx) => (ink(gx, gy) ? '#' : '.')).join(''),
    ).join('\n');

  it('reads exactly the face\'s glyphs on a whole value', () => {
    expect(band(reelInk(masks, [7 * COUNT_EM, 1 * COUNT_EM]), 2)).toBe(band(countInk(masks, '71'), 2));
    expect(reelRow(7)).toBe(7 * COUNT_EM);
  });

  it('rolls a font pixel at a time, the next digit coming up from below over one blank row', () => {
    // Three rows short of the 7: the 6's last two rows (unknown here, blank), its blank
    // row, then the 7's top four rows under them.
    const ink = reelInk(masks, [reelRow(7 - 3 / COUNT_EM)]);
    for (let x = 0; x < 7; x += 1) {
      expect(ink(x, 3)).toBe(true); // the 7's top row, now on the band's fourth
      expect(ink(x, 2)).toBe(false);
    }
    expect(ink(6, 4)).toBe(true);
    expect(ink(0, 4)).toBe(false);
    // A strip offset between two font pixels is floored to the whole pixel.
    expect(reelRow(7 - 2.5 / COUNT_EM)).toBe(7 * COUNT_EM - 3);
  });

  it('wraps from 9 back to 0, and is blank on an offset that is not a whole pixel', () => {
    expect(reelRow(10)).toBe(0);
    expect(reelRow(9.99)).toBe(REEL_ROWS - 1);
    expect(band(reelInk(masks, [REEL_ROWS + COUNT_EM]), 1)).toBe(band(countInk(masks, '1'), 1));
    expect(reelInk(masks, [0.5])(1, 0)).toBe(false);
  });
});

describe('glyphBoxes — each glyph\'s ink box', () => {
  it('spans each glyph\'s own ink columns on the advance', () => {
    expect(glyphBoxes(masks, '171')).toEqual([
      { x0: 0, x1: 2 },
      { x0: 8, x1: 15 },
      { x0: 16, x1: 18 },
    ]);
  });
});

describe('capCorners — where the count\'s glints stand', () => {
  it('seats a glint in each outer corner of the cap line, the slots asked for only', () => {
    const ink = countInk(masks, '17');
    // At 10px a font pixel with 4px glints: the 1's cap (columns 0–1), the 7's (8–14).
    expect(capCorners(ink, 0, 2, 10, 4)).toEqual([
      [0, 0],
      [16, 0],
      [80, 0],
      [146, 0],
    ]);
    // One slot at a time: the 7's alone.
    expect(capCorners(ink, 1, 2, 10, 4)).toEqual([
      [80, 0],
      [146, 0],
    ]);
  });
});
