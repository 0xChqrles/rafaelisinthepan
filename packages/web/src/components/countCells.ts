import { GLYPH_ROWS, type DigitMask } from './digitMasks';

// THE RESULT'S COUNT AS CELLS (pure): the count `SolvedCard` draws is Press Start 2P on its own
// pixel grid — every glyph an 8-pixel ADVANCE holding its 7×7 ink (`digitMasks.ts`, the face's
// own digits), so a number set in it can be drawn cell by cell (the meter's charge, the foil,
// the heat's clearing) on exactly the grid the DOM text lays out: glyph i starts at i em.
//
// THE COUNT'S BOX IS ITS INK: its band is the face's cap height (7 of the em's 8 rows), and its
// width drops the last glyph's trailing blank column (`inkEms`), so the number centres on what
// it prints, not on an advance that ends in a blank.
//
// WHOLE SCALES ONLY: the face is crisp at multiples of 8px, so the count's size is the LARGEST
// multiple of 8 whose ink fits the hero's width, between a floor and a ceiling that depend on
// the column (`countSize`): a phone's 160 (the share card's own), a short phone's 128 (SHARE
// must stay on screen), the desktop's 192.

// Font pixels to the em: a glyph's advance.
export const COUNT_EM = 8;
export const COUNT_ROWS = GLYPH_ROWS;

export const COUNT_MIN_PX = 32;
export const COUNT_MAX_PX = 160;
export const COUNT_MAX_SHORT_PX = 128;
export const COUNT_MAX_WIDE_PX = 192;

// A string of `glyphs` digits is this many ems wide on its ink: every advance but the last
// one's trailing blank column.
export const inkEms = (glyphs: number): number => glyphs - 1 / COUNT_EM;

// The count's size in px: the largest whole multiple of 8 at which a box `ems` wide fits
// `width`, under the column's ceiling (`wide`: the desktop's; `short`: a short phone's).
export function countSize(width: number, ems: number, wide: boolean, short: boolean): number {
  const max = wide ? COUNT_MAX_WIDE_PX : short ? COUNT_MAX_SHORT_PX : COUNT_MAX_PX;
  const fit = Math.floor(width / (ems * COUNT_EM)) * COUNT_EM;
  return Math.max(COUNT_MIN_PX, Math.min(max, fit));
}

// A string's INK on the face's grid: `ink(gx, gy)` in font pixels, glyph i's columns being
// i·8 … i·8 + 7. Anything that is not a digit is blank.
export function countInk(masks: readonly DigitMask[], text: string): (gx: number, gy: number) => boolean {
  const width = text.length * COUNT_EM;
  return (gx, gy) => {
    if (gy < 0 || gy >= COUNT_ROWS || gx < 0 || gx >= width) return false;
    const mask = masks[Number(text[Math.floor(gx / COUNT_EM)])] as DigitMask | undefined;
    const x = gx % COUNT_EM;
    return mask !== undefined && x < mask.w && mask.rows[gy * mask.w + x] === 1;
  };
}

// Each glyph's INK BOX, in font pixels: its first and last inked columns (end exclusive) over
// the whole band. A glyph with no ink (not a digit) has none.
export function glyphBoxes(masks: readonly DigitMask[], text: string): { x0: number; x1: number }[] {
  const boxes: { x0: number; x1: number }[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const mask = masks[Number(text[i])] as DigitMask | undefined;
    if (mask === undefined) continue;
    boxes.push({ x0: i * COUNT_EM, x1: i * COUNT_EM + mask.w });
  }
  return boxes;
}

// Where a count's GLINTS may stand: the cap line's outer corners of the glyphs from `from` to
// `to` (the digits the tally has written, not the odometer's zeros before them) — the top-left
// of a `cell`-px glint seated in the corner of the corner's own ink pixel, in CSS px at `px` a
// font pixel. A glint's centre stands ON the ink; its arms run out past the edge.
export function capCorners(
  ink: (gx: number, gy: number) => boolean,
  from: number,
  to: number,
  px: number,
  cell: number,
): [number, number][] {
  const corners: [number, number][] = [];
  for (let gx = from * COUNT_EM; gx < to * COUNT_EM; gx += 1) {
    if (!ink(gx, 0)) continue;
    if (!ink(gx - 1, 0)) corners.push([gx * px, 0]);
    if (!ink(gx + 1, 0)) corners.push([(gx + 1) * px - cell, 0]);
  }
  return corners;
}
