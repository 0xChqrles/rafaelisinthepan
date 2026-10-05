// The editor's two canvas overlays, where they encode a rule: the palette sweep's snapshot is
// the canvas EXACTLY as it stood — ground, ink and the grid's specks (`canvasPicture`)
// — and the foil stamp never lays a foil cell across two of the mark's pixels (`stampGrain`).

import { describe, expect, it } from 'vitest';
import { AVATAR_CELLS, AVATAR_PALETTES } from '@whippin/shared';
import { canvasPicture } from './DitherWipe';
import { speckOffset } from './tools';
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

  it("carries the grid's specks exactly where the canvas draws them: the middle of every empty cell", () => {
    const at0 = speckOffset(CELL);
    const speck = at(3 * CELL + at0, 3 * CELL + at0);
    expect(speck).not.toBe(hexToAbgr(bg));
    expect(speck).not.toBe(hexToAbgr(fg));
    // Only the speck's own 2px: the raster cells round it are ground.
    expect(at(3 * CELL + at0 + 2, 3 * CELL + at0)).toBe(hexToAbgr(bg));
    expect(at(3 * CELL + at0, 3 * CELL + at0 - 2)).toBe(hexToAbgr(bg));
    // The outer ring is specked too — the lattice covers the whole board.
    expect(at(at0, at0)).toBe(speck);
    expect(at(9 * CELL + at0, 0 * CELL + at0)).toBe(speck);
    // An inked cell has no speck.
    expect(at(CELL + at0, CELL + at0)).toBe(hexToAbgr(fg));
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
