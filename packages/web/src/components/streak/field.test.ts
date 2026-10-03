import { describe, expect, it } from 'vitest';
import { RESERVE_BITS, layout } from './geometry';
import { measureField } from './field';

const L = layout(390, 844, RESERVE_BITS, 14);

describe('the streak scene’s field', () => {
  it('leaves a word’s box bare of every effect, the subject’s room bare of the orbits only', () => {
    const word = { x0: 10, y0: 40, x1: 20, y1: 44, margin: 3 };
    const subject = { x0: 60, y0: 100, x1: 70, y1: 110, margin: 3, subject: true };
    const f = measureField(L, [word, subject]);
    const at = (x: number, y: number) => y * L.cols + x;
    // Inside: fully clear; only the word keeps the forge's sparks and the glitter off too.
    expect(f.CLEAR[at(15, 42)]).toBe(1);
    expect(f.WORDS[at(15, 42)]).toBe(1);
    expect(f.CLEAR[at(65, 105)]).toBe(1);
    expect(f.WORDS[at(65, 105)]).toBe(0);
    // Past the margin, free again.
    expect(f.CLEAR[at(15, 50)]).toBe(0);
    // Between, dithered back in: neither bare nor free.
    const edge = f.CLEAR[at(15, 45)];
    expect(edge > 0 && edge < 1).toBe(true);
  });

  it('keeps the lockup’s top band bare on any screen', () => {
    const f = measureField(L, []);
    const foot = Math.floor(L.topBand / L.cell) - 1;
    for (let y = 0; y < foot; y += 1) for (let x = 0; x < L.cols; x += 1) expect(f.CLEAR[y * L.cols + x]).toBe(1);
  });

  it('visits exactly the cells at a distance in [r0, r1) from the count', () => {
    const f = measureField(L, []);
    for (const [r0, r1] of [
      [0, 3],
      [10.5, 12.25],
      [f.maxR - 4, f.maxR + 1],
    ]) {
      const seen = new Set<number>();
      f.withinRadius(r0, r1, (i) => seen.add(i));
      const want = new Set<number>();
      for (let i = 0; i < f.n; i += 1) if (f.R[i] >= r0 && f.R[i] < r1) want.add(i);
      expect(seen).toEqual(want);
    }
  });

  it('measures every link’s metal, and keeps the dotted rail a cell off each', () => {
    const f = measureField(L, []);
    expect(f.linkCells).toHaveLength(7);
    for (let d = 0; d < 7; d += 1) {
      expect(f.linkCells[d].length).toBeGreaterThan(0);
      for (const c of f.linkCells[d]) {
        expect(f.cover[c.i]).toBe(d);
        expect(f.nearLink[c.i]).toBe(0);
      }
    }
  });
});
