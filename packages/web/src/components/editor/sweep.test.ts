// The editor's canvas overlays, where they encode a rule: the canvas's picture — and the
// palette sweep's snapshot, which IS that picture — is the drawing on its 1px grid, the cells
// on an even pitch so the house's 2px dither lands on every cell's own edge (`picture.ts`);
// a pop never decides what the canvas shows (`popFrame`); the foil stamp never lays a foil
// cell across two of the mark's pixels (`stampGrain`).

import { describe, expect, it } from 'vitest';
import { AVATAR_CELLS, AVATAR_PALETTES } from '@whippin/shared';
import { canvasPicture, canvasSide, cellAtPoint, cellStart, ditherCell, lineRgb } from './picture';
import { POP_MS, SPARK_MS, popFrame } from './EditorCanvas';
import { stampGrain } from '../FoilStamp';
import { abgr, hexToAbgr } from '../raster';

describe("the canvas's picture (and the sweep's snapshot)", () => {
  const CELL = 31;
  const side = canvasSide(CELL);
  const cells = new Array<number>(AVATAR_CELLS).fill(0);
  cells[11] = 1; // (1, 1)
  const { bg, fg } = AVATAR_PALETTES[2];
  const picture = canvasPicture(2, cells, CELL);
  const at = (x: number, y: number) => picture[y * side + x];
  const line = abgr(...lineRgb(2));

  it('is ten cells a side on a 1px grid, closed by the frame line', () => {
    expect(side).toBe(10 * (CELL + 1) + 1);
    expect(picture).toHaveLength(side * side);
    expect(at(0, 0)).toBe(line);
    expect(at(side - 1, side - 1)).toBe(line);
    // Between two cells: one line pixel, then the next cell.
    expect(at(cellStart(1, CELL) - 1, 10)).toBe(line);
    expect(at(cellStart(1, CELL) - 2, 10)).toBe(hexToAbgr(bg));
  });

  it('paints the ink and the ground in the palette given, to the cell edge', () => {
    const x = cellStart(1, CELL);
    expect(at(x, x)).toBe(hexToAbgr(fg));
    expect(at(x + CELL - 1, x + CELL - 1)).toBe(hexToAbgr(fg));
    expect(at(x + CELL, x)).toBe(line);
    expect(at(cellStart(2, CELL) + 5, cellStart(2, CELL) + 5)).toBe(hexToAbgr(bg));
  });

  it("draws its lines in the ground's own darker shade, never a second ink", () => {
    expect(line).not.toBe(hexToAbgr(bg));
    expect(line).not.toBe(hexToAbgr(fg));
    const ground = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16));
    lineRgb(2).forEach((c, k) => expect(c).toBeLessThan(ground[k] || 1));
  });

  it("starts every cell on a 2px dither cell of its own (an odd cell, an even pitch)", () => {
    for (const cell of [15, 21, 25, 31, 33, 37]) {
      for (let k = 0; k < 10; k += 1) {
        const x = cellStart(k, cell);
        expect(ditherCell(x)).not.toBe(ditherCell(x - 1));
      }
    }
  });

  it('reads a point back to the cell under it, a line pixel to the cell before it', () => {
    expect(cellAtPoint(cellStart(3, CELL) + 2, cellStart(7, CELL) + 2, CELL)).toBe(73);
    expect(cellAtPoint(cellStart(4, CELL) - 1, cellStart(0, CELL), CELL)).toBe(3);
    expect(cellAtPoint(0, 0, CELL)).toBe(0);
    expect(cellAtPoint(side - 1, side - 1, CELL)).toBe(99);
    expect(cellAtPoint(side, 4, CELL)).toBeNull();
    expect(cellAtPoint(-1, 4, CELL)).toBeNull();
  });
});

describe("a paint's pop", () => {
  const inked = new Array<number>(AVATAR_CELLS).fill(0);
  inked[44] = 1;
  const pop = { cell: 44, kind: 'in' as const, at: 1000 };

  it('pops proud and throws its eight sparks while its cell holds the ink it painted', () => {
    const { rects, alive } = popFrame([pop], inked, 31, 1010);
    expect(alive).toBe(true);
    expect(rects).toHaveLength(9);
    // Proud of its cell, on whole pixels.
    expect(rects[0].w).toBeGreaterThan(31);
    for (const r of rects) for (const v of [r.x, r.y, r.w, r.h]) expect(Number.isInteger(v)).toBe(true);
  });

  it('draws nothing over a cell no longer holding what it painted', () => {
    const erased = new Array<number>(AVATAR_CELLS).fill(0);
    expect(popFrame([pop], erased, 31, 1010).rects).toEqual([]);
    expect(popFrame([{ ...pop, kind: 'out' }], inked, 31, 1010).rects).toEqual([]);
  });

  it('is over, leaving the picture alone, once its time is up', () => {
    expect(popFrame([pop], inked, 31, 1000 + SPARK_MS)).toEqual({ rects: [], alive: false });
    expect(popFrame([{ ...pop, kind: 'out' }], new Array<number>(AVATAR_CELLS).fill(0), 31, 1000 + POP_MS)).toEqual({
      rects: [],
      alive: false,
    });
  });
});

describe("the foil stamp's grain", () => {
  it("is the house's 2px wherever the mark's cell divides by it", () => {
    expect(stampGrain(300, true)).toBe(2);
    expect(stampGrain(320, true)).toBe(2); // the editor's canvas, on its 32px pitch
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
