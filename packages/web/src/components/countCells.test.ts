// The result's count as cells (`countCells.ts`): its size decides whether SHARE stays on a
// phone's screen, and its layout whether the canvas draws exactly the face's glyphs where the
// DOM text sets them.
import { describe, expect, it } from 'vitest';
import {
  COUNT_EM,
  COUNT_MAX_PX,
  COUNT_MAX_SHORT_PX,
  COUNT_MAX_WIDE_PX,
  COUNT_MIN_PX,
  capCorners,
  countInk,
  countSize,
  glyphBoxes,
  inkEms,
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
  it('is always a whole multiple of 8px, inside its floor and ceiling', () => {
    for (let width = 100; width <= 700; width += 7) {
      for (const digits of [1, 2, 3]) {
        const size = countSize(width, inkEms(digits), false, false);
        expect(size % 8).toBe(0);
        expect(size).toBeGreaterThanOrEqual(COUNT_MIN_PX);
        expect(size).toBeLessThanOrEqual(COUNT_MAX_PX);
      }
    }
  });

  it('fits its ink in the hero: three digits at 320 (a 260px hero) take 88px', () => {
    const size = countSize(260, inkEms(3), false, true);
    expect(size).toBe(88);
    expect(size * inkEms(3)).toBeLessThanOrEqual(260);
    expect((size + 8) * inkEms(3)).toBeGreaterThan(260);
  });

  it('caps a phone at the share card\'s 160, a short phone at 128, the desktop at 192', () => {
    expect(countSize(330, inkEms(2), false, false)).toBe(COUNT_MAX_PX);
    expect(countSize(330, inkEms(2), false, true)).toBe(COUNT_MAX_SHORT_PX);
    expect(countSize(616, inkEms(2), true, false)).toBe(COUNT_MAX_WIDE_PX);
  });

  it('never goes under the floor, even when nothing fits', () => {
    expect(countSize(40, inkEms(3), false, false)).toBe(COUNT_MIN_PX);
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
  it('seats a glint in each outer corner of the cap line, the written digits only', () => {
    const ink = countInk(masks, '17');
    // At 10px a font pixel with 4px glints: the 1's cap (columns 0–1), the 7's (8–14).
    expect(capCorners(ink, 0, 2, 10, 4)).toEqual([
      [0, 0],
      [16, 0],
      [80, 0],
      [146, 0],
    ]);
    // The odometer's zero before the tally's digits wears none.
    expect(capCorners(ink, 1, 2, 10, 4)).toEqual([
      [80, 0],
      [146, 0],
    ]);
  });
});
