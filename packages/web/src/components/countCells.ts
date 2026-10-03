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
// multiple of 8 whose box fits both the hero's width and the height the card can spare it
// (SHARE must stay above the fold), between a floor and a ceiling that depends on the column
// (`countSize`): a phone's 160 (the share card's own), the desktop's 192.
//
// THE TALLY ROLLS ON THE SAME GRID: each glyph slot is a REEL of the face's digits (`reelInk`)
// standing at a whole font pixel (`reelRow`), so the odometer `countRun.ts` drives never puts
// a glyph between two of the face's pixels.

// Font pixels to the em: a glyph's advance.
export const COUNT_EM = 8;
export const COUNT_ROWS = GLYPH_ROWS;

export const COUNT_MIN_PX = 32;
export const COUNT_MAX_PX = 160;
export const COUNT_MAX_WIDE_PX = 192;

// A string of `glyphs` digits is this many ems wide on its ink: every advance but the last
// one's trailing blank column.
export const inkEms = (glyphs: number): number => glyphs - 1 / COUNT_EM;

// The count's size in px: the largest whole multiple of 8 at which its box — `ems` wide on
// its ink, the face's cap height (COUNT_ROWS of the em's 8 rows) tall — fits `width` and
// `height`, under the column's ceiling (`wide`: the desktop's), never under the floor.
export function countSize(width: number, height: number, ems: number, wide: boolean): number {
  const max = wide ? COUNT_MAX_WIDE_PX : COUNT_MAX_PX;
  const fitWidth = Math.floor(width / (ems * COUNT_EM)) * COUNT_EM;
  const fitHeight = Math.floor(height / COUNT_ROWS) * COUNT_EM;
  return Math.max(COUNT_MIN_PX, Math.min(max, fitWidth, fitHeight));
}

// A string's INK on the face's grid: `ink(gx, gy)` in font pixels, glyph i's columns being
// i·8 … i·8 + 7. Anything that is not a digit is blank.
export function countInk(masks: readonly DigitMask[], text: string): (gx: number, gy: number) => boolean {
  return reelInk(
    masks,
    Array.from(text, (c) => (c >= '0' && c <= '9' ? Number(c) * COUNT_EM : NaN)),
  );
}

// THE COUNT'S REELS (`countRun.ts`): each glyph slot a strip of the face's ten digits, 0 to 9
// top to bottom, every glyph its 7 ink rows over one blank row — REEL_ROWS font pixels round.
// A slot shows the strip's 7 rows from its whole-pixel offset down, so a reel rolls on the
// face's own grid, one font pixel at a time.
export const REEL_ROWS = 10 * COUNT_EM;

// A reel standing at `pos` values (`countRun.ts` `CountReel`): its strip offset, in whole
// font pixels.
export const reelRow = (pos: number): number =>
  ((Math.floor(pos * COUNT_EM) % REEL_ROWS) + REEL_ROWS) % REEL_ROWS;

// The ink of reels standing at `rows` (each slot's strip offset, `reelRow`): the same grid as
// `countInk`, glyph slot i's columns i·8 … i·8 + 7. A slot whose offset is not a whole number
// is blank, and so is a digit the masks do not know.
export function reelInk(masks: readonly DigitMask[], rows: readonly number[]): (gx: number, gy: number) => boolean {
  const width = rows.length * COUNT_EM;
  return (gx, gy) => {
    if (gy < 0 || gy >= COUNT_ROWS || gx < 0 || gx >= width) return false;
    const row = rows[Math.floor(gx / COUNT_EM)];
    if (!Number.isInteger(row)) return false;
    const s = (((row + gy) % REEL_ROWS) + REEL_ROWS) % REEL_ROWS;
    const mask = masks[Math.floor(s / COUNT_EM)] as DigitMask | undefined;
    const y = s % COUNT_EM;
    const x = gx % COUNT_EM;
    return mask !== undefined && y < COUNT_ROWS && x < mask.w && mask.rows[y * mask.w + x] === 1;
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
