// CONTRACT (light): the app draws ONE `∞` (root AGENTS.md, Sentence round; shared AGENTS.md,
// glyphs) — the result's headline, the share card's, a group board's ended row — from ONE
// path in ONE box. The path is pinned here to the drawing its comment shows, cell for cell,
// and to the box every surface sizes it by.

import { describe, expect, it } from 'vitest';
import { INFINITY_EM_HEIGHT, INFINITY_EM_WIDTH, INFINITY_GLYPH } from './glyphs';

// The glyph as its comment draws it.
const ART = ['.##...##.', '#..#.#..#', '#...#...#', '#..#.#..#', '.##...##.'];
const RECT = /M(\d+) (\d+)h(\d+)v(\d+)h-(\d+)z/g;

// The path's cells, read back off its rectangles: how many rectangles cover each one.
function cellsOf(path: string, width: number, height: number): number[][] {
  const grid = Array.from({ length: height }, () => new Array<number>(width).fill(0));
  for (const [, x, y, w, h, back] of path.matchAll(RECT)) {
    expect(Number(back)).toBe(Number(w));
    for (let gy = Number(y); gy < Number(y) + Number(h); gy += 1) {
      for (let gx = Number(x); gx < Number(x) + Number(w); gx += 1) grid[gy][gx] += 1;
    }
  }
  return grid;
}

describe('INFINITY_GLYPH', () => {
  it('is drawn in a 9 × 5 box, a cell per font pixel', () => {
    expect(INFINITY_GLYPH.width).toBe(9);
    expect(INFINITY_GLYPH.height).toBe(5);
    expect(INFINITY_GLYPH.viewBox).toBe('0 0 9 5');
    expect(INFINITY_EM_WIDTH).toBeCloseTo((INFINITY_EM_HEIGHT * 9) / 5, 10);
  });

  it('is nothing but whole-cell rectangles, every one inside the box', () => {
    const { path, width, height } = INFINITY_GLYPH;
    const rects = [...path.matchAll(RECT)];
    expect(rects.length).toBeGreaterThan(0);
    // Nothing else in the path: no curve, no stray command.
    expect(path.replace(RECT, '').trim()).toBe('');
    for (const [, x, y, w, h] of rects) {
      expect(Number(x) + Number(w)).toBeLessThanOrEqual(width);
      expect(Number(y) + Number(h)).toBeLessThanOrEqual(height);
    }
  });

  it('is the drawing: two loops that cross in one cell, mirror-symmetric, each cell inked once', () => {
    const grid = cellsOf(INFINITY_GLYPH.path, INFINITY_GLYPH.width, INFINITY_GLYPH.height);
    for (const row of grid) for (const n of row) expect(n).toBeLessThanOrEqual(1);
    const rows = grid.map((row) => row.map((n) => (n ? '#' : '.')).join(''));
    expect(rows).toEqual(ART);
    expect(grid.flat().reduce((n, c) => n + c, 0)).toBe(19);
    // The crossing: the middle cell of the middle row.
    expect(grid[2][4]).toBe(1);
    for (const row of rows) expect([...row].reverse().join('')).toBe(row);
  });
});
