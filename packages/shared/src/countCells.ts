import { GLYPH_ROWS, type DigitMask } from './glyphs';

// THE RESULT'S COUNT AS CELLS (pure): the count the result draws — on the screen (web
// `SolvedCard`) and on the share card (`cardSvg.ts`) — is Press Start 2P on its own pixel grid:
// every glyph an 8-pixel ADVANCE holding its 7×7 ink (`glyphs.ts` `DIGIT_MASKS`, the face's own
// digits), so a number set in it can be drawn cell by cell (the meter's charge, the foil, the
// heat's clearing) on exactly the grid the type lays out: glyph i starts at i em.
//
// THE COUNT'S BOX IS ITS INK: its band is the face's cap height (7 of the em's 8 rows), and its
// width drops the last glyph's trailing blank column (`inkEms`), so the number centres on what
// it prints, not on an advance that ends in a blank.
//
// THE TALLY SPINS ON THE SAME GRID (the screen's): each glyph slot is a REEL of the face's
// digits (`reelInk`) standing at a whole font pixel (`reelRow`), so the slot machine the web's
// `countRun.ts` drives never puts a glyph between two of the face's pixels.

// Font pixels to the em: a glyph's advance.
export const COUNT_EM = 8;
export const COUNT_ROWS = GLYPH_ROWS;

// A string of `glyphs` digits is this many ems wide on its ink: every advance but the last
// one's trailing blank column.
export const inkEms = (glyphs: number): number => glyphs - 1 / COUNT_EM;

// A string's INK on the face's grid: `ink(gx, gy)` in font pixels, glyph i's columns being
// i·8 … i·8 + 7. Anything that is not a digit is blank.
export function countInk(masks: readonly DigitMask[], text: string): (gx: number, gy: number) => boolean {
  return reelInk(
    masks,
    Array.from(text, (c) => (c >= '0' && c <= '9' ? Number(c) * COUNT_EM : NaN)),
  );
}

// THE COUNT'S REELS: each glyph slot a strip of the face's ten digits, 0 to 9 top to bottom,
// every glyph its 7 ink rows over one blank row — REEL_ROWS font pixels round. A slot shows the
// strip's 7 rows from its whole-pixel offset down, so a reel rolls on the face's own grid, one
// font pixel at a time.
export const REEL_ROWS = 10 * COUNT_EM;

// A reel standing at `pos` values: its strip offset, in whole font pixels.
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

// Where a count's GLINTS may stand: the cap line's outer corners of the glyph slots from
// `from` to `to` (one reel at a time, so each can carry its own shake) — the top-left of a
// `cell`-px glint seated in the corner of the corner's own ink pixel, in px at `px` a font
// pixel. A glint's centre stands ON the ink; its arms run out past the edge.
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
