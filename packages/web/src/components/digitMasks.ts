import digitsUrl from '../assets/digits.png';

// THE PIXEL DIGITS' GLYPHS (`assets/digits.png`, the pixel face's own 7×7 digits), decoded
// once per session and shared by every surface that draws a number as BLOCKS: the score
// watermark (`CellDigits`), the streak celebration (`components/streak/`) and the result's
// count (`SolvedCard`, through `countCells.ts`). Alpha is the mask — the art's RGB is ignored,
// so a surface paints the blocks in its own ink — and each slot is trimmed to its ink
// columns, so widths stay proportional (the 1 is narrower). Every glyph's ink starts on its
// slot's first column, so a mask's column x is also the face's column x: a surface setting
// the digits on the face's own 8-pixel advance draws exactly the DOM text's glyphs.

export const GLYPH_ROWS = 7;
// One glyph pixel of spacing between digits (scales with the digits).
export const GLYPH_GAP = 1;

export type DigitMask = { w: number; rows: Uint8Array };

// digits.png is a 10-slot spritesheet in KEYBOARD order (1..9 then 0), 7px slots.
const SHEET_ORDER = '1234567890';
const SLOT_W = 7;

let masksPromise: Promise<DigitMask[]> | null = null;
// The decoded glyphs once they are in: a surface mounted after the decode draws them on its
// first frame (the result's count is born in its foil, never white text first).
let decoded: DigitMask[] | null = null;

export function digitMasksNow(): DigitMask[] | null {
  return decoded;
}

export function loadDigitMasks(): Promise<DigitMask[]> {
  if (!masksPromise) {
    masksPromise = (async () => {
      const img = new Image();
      img.src = digitsUrl;
      await img.decode();
      const sheet = document.createElement('canvas');
      sheet.width = img.width;
      sheet.height = img.height;
      const ctx = sheet.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, img.width, img.height).data;
      const on = (x: number, y: number) => data[(y * img.width + x) * 4 + 3] > 127;
      const masks: DigitMask[] = new Array(10);
      for (let slot = 0; slot < 10; slot++) {
        const x0 = slot * SLOT_W;
        let left = SLOT_W;
        let right = -1;
        for (let x = 0; x < SLOT_W; x++) {
          for (let y = 0; y < GLYPH_ROWS; y++) {
            if (on(x0 + x, y)) {
              if (x < left) left = x;
              if (x > right) right = x;
              break;
            }
          }
        }
        const w = Math.max(1, right - left + 1);
        const rows = new Uint8Array(w * GLYPH_ROWS);
        for (let y = 0; y < GLYPH_ROWS; y++)
          for (let x = 0; x < w; x++) rows[y * w + x] = on(x0 + left + x, y) ? 1 : 0;
        masks[Number(SHEET_ORDER[slot])] = { w, rows };
      }
      decoded = masks;
      return masks;
    })().catch((error: unknown) => {
      // A failed decode is not cached: the next surface to ask tries again.
      masksPromise = null;
      throw error;
    });
  }
  return masksPromise;
}
