// The result's count as cells (`countCells.ts`): its layout decides whether the screen's canvas
// and the share card draw exactly the face's glyphs where the type sets them.
import { describe, expect, it } from 'vitest';
import {
  COUNT_EM,
  COUNT_ROWS,
  REEL_ROWS,
  capCorners,
  countInk,
  glyphBoxes,
  inkEms,
  reelInk,
  reelRow,
} from './countCells';
import { DIGIT_MASKS, GLYPH_ROWS, type DigitMask } from './glyphs';

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

describe('inkEms — the count\'s box is its ink', () => {
  it('measures the ink: every advance but the last glyph\'s trailing blank column', () => {
    expect(inkEms(1)).toBe(7 / 8);
    expect(inkEms(3)).toBe(3 - 1 / 8);
  });
});

describe('DIGIT_MASKS — the face\'s own digits', () => {
  it('holds the ten digits on the 7-row band, inked from their first column', () => {
    expect(DIGIT_MASKS).toHaveLength(10);
    for (const { w, rows } of DIGIT_MASKS) {
      expect(rows).toHaveLength(w * GLYPH_ROWS);
      expect(w).toBeLessThanOrEqual(COUNT_EM - 1); // a blank column ends every advance
      // Its first and last columns both carry ink: the mask is its ink box.
      const column = (x: number) => Array.from({ length: GLYPH_ROWS }, (_, y) => rows[y * w + x]).some(Boolean);
      expect(column(0)).toBe(true);
      expect(column(w - 1)).toBe(true);
    }
    // The 1 is the narrow one.
    expect(DIGIT_MASKS.map((m) => m.w)).toEqual([7, 6, 7, 7, 7, 7, 7, 7, 7, 7]);
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
