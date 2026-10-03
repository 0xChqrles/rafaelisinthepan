import { describe, expect, it } from 'vitest';
import { LINK_PITCH, LINK_PITCH_TIGHT, LINK_W, linkCellsAt } from './sprites';
import {
  RESERVE_BITS,
  STAR_H,
  STAR_W,
  layout,
  numberCells,
  overlaps,
  pastOrbits,
  pastWeeks,
  ringXY,
  weekPath,
} from './geometry';

// The face's widths: a `1` is six glyph pixels, every other digit seven, one between.
const digitsWide = (n: number) => String(n).length * 8 - 1 - (String(n).startsWith('1') ? 1 : 0);

const SIZES = [
  [320, 568],
  [375, 667],
  [390, 844],
  [844, 390],
  [1280, 800],
] as const;

describe('the streak orbit layout', () => {
  it('sets the count at one whole face for one to three digits, inside the gutters, on every screen', () => {
    for (const [w, h] of SIZES) {
      const ks = [1, 10, 100].map((n) => layout(w, h, Math.max(RESERVE_BITS, digitsWide(n)), digitsWide(n)).k);
      // A hundredth day is never drawn smaller than a tenth or a first.
      expect(new Set(ks).size).toBe(1);
      const L = layout(w, h, RESERVE_BITS, digitsWide(100));
      expect(Number.isInteger(L.k) && L.k >= 1).toBe(true);
      expect(RESERVE_BITS * L.k * L.cell).toBeLessThanOrEqual(w - 32);
    }
  });

  it('draws in whole CSS pixels: 3 a cell on a phone either way up, 4 from a tablet', () => {
    expect(SIZES.map(([w, h]) => layout(w, h, RESERVE_BITS).cell)).toEqual([3, 3, 3, 3, 4]);
  });

  it('keeps the week a Monday-first chain, left to right, every link and initial on screen', () => {
    for (const [w, h] of SIZES) {
      const L = layout(w, h, RESERVE_BITS, 14);
      for (let i = 1; i < 7; i += 1) {
        // At the chain's pitch, so a link never touches the next: the edge-on link spans the gap.
        expect([LINK_PITCH, LINK_PITCH_TIGHT]).toContain(L.pitch);
        expect(L.links[i].x - L.links[i - 1].x).toBe(L.pitch);
      }
      for (const n of L.links) {
        // Whole cells: a centre on a cell's middle across, a cell's edge down.
        expect(Number.isInteger(n.x - 0.5) && Number.isInteger(n.y)).toBe(true);
        expect((n.x - LINK_W / 2) * L.cell).toBeGreaterThanOrEqual(16);
        expect((n.x + LINK_W / 2) * L.cell).toBeLessThanOrEqual(w - 16);
      }
      // The initials on one line, under the chain's lowest foot.
      expect(new Set(L.labels.map((l) => l.y)).size).toBe(1);
      for (const label of L.labels) expect(label.y).toBeLessThan(L.hintY - 12);
    }
  });

  it('smiles along the orbit’s floor, stepping at most two cells between links', () => {
    for (const [w, h] of SIZES) {
      const arc = layout(w, h, RESERVE_BITS, 14).links.map((l) => l.y);
      // Thursday lowest; each side rising toward its end, mirrored.
      expect(Math.max(...arc)).toBe(arc[3]);
      for (let i = 0; i < 3; i += 1) {
        expect(arc[i]).toBe(arc[6 - i]);
        expect(arc[i]).toBeLessThan(arc[i + 1]);
      }
      // An edge-on link threads both holes straight or with one step: a hole is four cells tall.
      for (let i = 1; i < 7; i += 1) expect(Math.abs(arc[i] - arc[i - 1])).toBeLessThanOrEqual(2);
    }
    // Every day wears the one hand-drawn upright link: 11 × 8, the hole's four corners deep.
    const up = linkCellsAt({ x: 5.5, y: 4 });
    expect(Math.max(...up.map((c) => c.x)) + 1).toBe(11);
    expect(Math.max(...up.map((c) => c.y)) + 1).toBe(8);
    expect(up.filter((c) => c.part === 'deep')).toHaveLength(4);
    expect(up.filter((c) => c.part === 'hole').length).toBe(24);
  });

  it('keeps the week’s orbit a closed shape inside the screen, wider than tall', () => {
    for (const [w, h] of SIZES) {
      const L = layout(w, h, RESERVE_BITS, 14);
      expect(L.ring.rx).toBeLessThanOrEqual(Math.min(L.cx, L.cols - L.cx) - 2);
      expect(L.ring.rx).toBeGreaterThan(L.ring.ry);
      expect(L.ring.rx).toBeGreaterThan(3 * L.pitch + LINK_W / 2);
    }
  });

  it('measures the week’s path from Monday through Sunday, round the crown, and back', () => {
    for (const [w, h] of SIZES) {
      const L = layout(w, h, RESERVE_BITS, 14);
      const p = weekPath(L);
      for (let i = 1; i < 7; i += 1) expect(p.dayAlong[i]).toBeGreaterThan(p.dayAlong[i - 1]);
      expect(p.dayAlong[0]).toBe(0);
      expect(p.weekEnd).toBeLessThan(p.crownAlong);
      expect(p.crownAlong).toBeLessThan(1);
      // Through every link's centre …
      const at = (sv: number) => {
        let j = 0;
        while (j < p.s.length - 1 && p.s[j] < sv) j += 1;
        return j;
      };
      for (let i = 0; i < 7; i += 1) {
        const j = at(p.dayAlong[i]);
        expect(Math.hypot(p.x[j] - L.links[i].x, p.y[j] - L.links[i].y)).toBeLessThan(0.5);
      }
      // … and out of Sunday's link with no corner: the orbit turns less than 20° from the
      // chain's own last lean, inside the link (no cusp where the loop meets the chain).
      const chain = Math.atan2(L.links[6].y - L.links[5].y, L.links[6].x - L.links[5].x);
      const a = Math.atan2(L.links[6].y - L.ring.cy, L.links[6].x - L.cx);
      const [x0, y0] = ringXY(L.ring, a);
      const [x1, y1] = ringXY(L.ring, a - 1e-4); // on round the orbit, toward the crown
      const leave = Math.atan2(y1 - y0, x1 - x0);
      expect(Math.abs(leave - chain), `${w}×${h}`).toBeLessThan((20 * Math.PI) / 180);
    }
  });

  it('strikes the ultra star on any day without crossing the count or its unit', () => {
    for (const [w, h] of SIZES) {
      const L = layout(w, h, RESERVE_BITS, 14);
      const countBox = {
        x0: (L.cx - 7 * L.k) * L.cell,
        y0: L.countTop * L.cell,
        x1: (L.cx + 7 * L.k) * L.cell,
        y1: (L.countTop + 7 * L.k) * L.cell,
      };
      // DAY STREAK: ten tracked mono capitals (0.6em advance + 0.16em tracking).
      const unitHalf = (10 * 0.76 * L.unitSize) / 2;
      const unitBox = {
        x0: w / 2 - unitHalf,
        y0: L.unitY - L.unitSize * 0.4,
        x1: w / 2 + unitHalf,
        y1: L.unitY + L.unitSize * 0.4 + 2,
      };
      for (const n of L.links) {
        const star = {
          x0: n.x * L.cell - (STAR_W * L.starScale) / 2,
          y0: n.y * L.cell - (STAR_H * L.starScale) / 2,
          x1: n.x * L.cell + (STAR_W * L.starScale) / 2,
          y1: n.y * L.cell + (STAR_H * L.starScale) / 2,
        };
        expect(overlaps(star, countBox)).toBe(false);
        expect(overlaps(star, unitBox)).toBe(false);
      }
    }
  });

  it('draws one orbit for each earlier week the run crossed — four at most on a phone, five wider — each outside the last', () => {
    expect(pastWeeks(1, 4)).toBe(0);
    expect(pastWeeks(5, 4)).toBe(0); // began this Monday
    expect(pastWeeks(6, 4)).toBe(1);
    expect(pastWeeks(12, 4)).toBe(1);
    expect(pastWeeks(13, 4)).toBe(2);
    for (const [w, h] of SIZES) {
      const L = layout(w, h, RESERVE_BITS, 14);
      expect(pastOrbits(L, 0)).toEqual([]);
      expect(pastOrbits(L, 1)).toHaveLength(1);
      const many = pastOrbits(L, 14);
      expect(many.length).toBeGreaterThanOrEqual(1);
      expect(many.length).toBeLessThanOrEqual(L.cell === 4 ? 5 : 4);
      let last = L.ring;
      for (const o of many) {
        expect(o.ry).toBeGreaterThan(last.ry);
        expect(o.rx).toBeGreaterThan(last.rx);
        last = { ...last, ...o };
      }
    }
  });
});

describe('the count as cells', () => {
  // Two glyphs: a 1 three pixels wide, a 2 two wide (the face's own sheet is decoded in the browser).
  const one = { w: 3, rows: new Uint8Array(3 * 7).fill(1) };
  const two = { w: 2, rows: new Uint8Array(2 * 7).fill(1) };
  const glyphs = [two, one, two, two, two, two, two, two, two, two];

  it('sets the digits side by side, one glyph pixel apart', () => {
    const m = numberCells(glyphs, 12);
    expect(m.w).toBe(3 + 1 + 2);
    expect(m.h).toBe(7);
    // The gap column is bare on every row; the glyphs are inked.
    for (let y = 0; y < 7; y += 1) {
      expect(m.bits[y * m.w + 3]).toBe(0);
      expect(m.bits[y * m.w + 0]).toBe(1);
      expect(m.bits[y * m.w + 5]).toBe(1);
    }
  });

  it('keeps a count’s width and no ink when the sheet never decoded (the dialog sets it as type)', () => {
    const m = numberCells(null, 100);
    expect(m.w).toBe(3 * 8 - 1);
    expect(m.bits.every((b) => b === 0)).toBe(true);
  });
});
