// The editor's two canvas overlays, where they encode a rule: the palette sweep's snapshot is
// the canvas EXACTLY as it stood — ground, ink and the grid's corner specks (`canvasPicture`)
// — and the foil stamp never lays a foil cell across two of the mark's pixels (`stampGrain`).

import { describe, expect, it } from 'vitest';
import { AVATAR_CELLS, AVATAR_PALETTES } from '@whippin/shared';
import { canvasPicture } from './DitherWipe';
import { stampGrain } from '../FoilStamp';
import { hexToAbgr } from '../raster';

describe("the palette sweep's snapshot", () => {
  const CELL = 30; // 15 raster cells of 2px a mark cell
  const n = (CELL * 10) / 2;
  const cells = new Array<number>(AVATAR_CELLS).fill(0);
  cells[11] = 1; // (1, 1)
  const { bg, fg } = AVATAR_PALETTES[2];
  const picture = canvasPicture(2, cells, CELL);
  const at = (px: number, py: number) => picture[(py / 2) * n + px / 2];

  it('paints the ink and the ground in the palette given', () => {
    expect(at(CELL + 10, CELL + 10)).toBe(hexToAbgr(fg));
    expect(at(2 * CELL + 10, 2 * CELL + 10)).toBe(hexToAbgr(bg));
  });

  it("carries the grid's speck in each empty cell's corner, never on the canvas's edge", () => {
    const speck = at(2 * CELL, 2 * CELL);
    expect(speck).not.toBe(hexToAbgr(bg));
    expect(speck).not.toBe(hexToAbgr(fg));
    // Only the corner's own 2px: the next raster cell over is ground.
    expect(at(2 * CELL + 2, 2 * CELL)).toBe(hexToAbgr(bg));
    // An inked cell has no speck; the first row and column have none.
    expect(at(CELL, CELL)).toBe(hexToAbgr(fg));
    expect(at(0, 2 * CELL)).toBe(hexToAbgr(bg));
    expect(at(2 * CELL, 0)).toBe(hexToAbgr(bg));
  });
});

describe("the foil stamp's grain", () => {
  it("is the house's 2px wherever the mark's cell divides by it", () => {
    expect(stampGrain(300, true)).toBe(2); // the editor's canvas, 30px cells
    expect(stampGrain(320, true)).toBe(2);
    expect(stampGrain(40, true)).toBe(2);
    expect(stampGrain(60, true)).toBe(2);
    expect(stampGrain(80, true)).toBe(2);
  });

  it("otherwise turns the mark's own pixels to foil, one whole pixel at a time", () => {
    expect(stampGrain(30, true)).toBe(3);
    expect(stampGrain(50, true)).toBe(5);
    expect(stampGrain(70, true)).toBe(7);
    // Every grain divides the mark's cell: no foil cell straddles two of its pixels.
    for (const side of [20, 30, 40, 50, 60, 70, 80, 90, 300, 340, 360]) {
      expect((side / 10) % stampGrain(side, true)).toBe(0);
    }
  });

  it('is the 2px cell over a box that is not a whole-pixel mark', () => {
    expect(stampGrain(55, true)).toBe(2);
    expect(stampGrain(50, false)).toBe(2);
  });
});
