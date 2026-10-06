// CONTRACT (light): the app draws ONE `∞` (root AGENTS.md, Sentence round; shared AGENTS.md,
// glyphs). A surface that draws it as blocks reads `INFINITY_MASK`, which is the path's own
// rectangles read as cells — so the mask is pinned to the glyph's drawing here, and to the
// path it comes from.

import { describe, expect, it } from 'vitest';
import { INFINITY_GLYPH, INFINITY_MASK } from './glyphs';

// The glyph as its comment draws it.
const ART = ['.##...##.', '#..#.#..#', '#...#...#', '#..#.#..#', '.##...##.'];

describe('INFINITY_MASK', () => {
  it('is the 9 × 5 glyph, a cell per font pixel', () => {
    expect(INFINITY_MASK.w).toBe(9);
    expect(INFINITY_MASK.rows.length).toBe(45);
  });

  it('is the drawing: two loops that cross in one cell, mirror-symmetric', () => {
    const rows = Array.from({ length: 5 }, (_, y) =>
      Array.from(INFINITY_MASK.rows.subarray(y * 9, y * 9 + 9), (c) => (c ? '#' : '.')).join(''),
    );
    expect(rows).toEqual(ART);
    expect(INFINITY_MASK.rows.reduce((n, c) => n + c, 0)).toBe(19);
    expect(INFINITY_MASK.rows[2 * 9 + 4]).toBe(1);
    for (const row of rows) expect([...row].reverse().join('')).toBe(row);
  });

  it('comes from the path: every rectangle lies inside the box', () => {
    const rects = [...INFINITY_GLYPH.path.matchAll(/M(\d+) (\d+)h(\d+)v(\d+)h-\d+z/g)];
    expect(rects.length).toBeGreaterThan(0);
    for (const [, x, y, w, h] of rects) {
      expect(Number(x) + Number(w)).toBeLessThanOrEqual(INFINITY_GLYPH.width);
      expect(Number(y) + Number(h)).toBeLessThanOrEqual(INFINITY_GLYPH.height);
    }
  });
});
