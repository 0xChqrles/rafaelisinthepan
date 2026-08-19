import { describe, expect, it } from 'vitest';
import { AVATAR_CELLS, AVATAR_SIZE } from '@whippin/shared';
import { avatarOutlinePath } from './avatarOutline';

// The tracer's contract is what the path FILLS, not how it is spelled: under the
// default nonzero rule the emitted loops must cover exactly the filled cells and
// nothing else. `fills()` below decides that from the path itself — winding numbers at
// sampled points — so the suite pins the geometry and the winding without pinning the
// command syntax, which is a rendering detail a browser never reads back.
//
// jsdom rasterizes nothing, so the property this renderer exists for (no seam at a
// fractional DPR) cannot be asserted here and is not attempted.

const grid = (...on: Array<[number, number]>) => {
  const cells = new Array<number>(AVATAR_CELLS).fill(0);
  for (const [x, y] of on) cells[y * AVATAR_SIZE + x] = 1;
  return cells;
};

// Parse the path back into its closed loops. The emitter only ever writes `M x y`,
// `L x y` and `Z`, so this is the whole grammar.
function loopsOf(path: string): Array<Array<[number, number]>> {
  const loops: Array<Array<[number, number]>> = [];
  for (const part of path.split('Z')) {
    if (part === '') continue;
    const points = part
      .slice(1) // drop the leading M
      .split('L')
      .map((pair) => pair.split(' ').map(Number) as [number, number]);
    loops.push(points);
  }
  return loops;
}

// The nonzero winding number of the loops around a point — the rule an SVG `fill`
// applies by default. Every edge is axis-aligned, so a crossing is a vertical edge
// spanning the point's y, counted by the direction it runs.
function winding(loops: Array<Array<[number, number]>>, px: number, py: number): number {
  let turns = 0;
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const [x1, y1] = loop[i];
      const [x2, y2] = loop[(i + 1) % loop.length];
      if (x1 !== x2 || x1 <= px) continue; // horizontal, or the crossing is behind us
      if (y1 <= py && y2 > py) turns += 1;
      else if (y2 <= py && y1 > py) turns -= 1;
    }
  }
  return turns;
}

// The assertion the whole suite rests on: the path fills a cell iff the grid does.
// Sampled at each cell's CENTRE and at four points just inside its corners, so a
// boundary off by a fraction of a cell cannot slip through.
function fills(cells: number[], cell = 10): boolean {
  const loops = loopsOf(avatarOutlinePath(cells, cell));
  const probes = [
    [0.5, 0.5],
    [0.1, 0.1],
    [0.9, 0.1],
    [0.1, 0.9],
    [0.9, 0.9],
  ];
  return cells.every((value, i) => {
    const x = (i % AVATAR_SIZE) * cell;
    const y = Math.floor(i / AVATAR_SIZE) * cell;
    return probes.every(
      ([dx, dy]) => (winding(loops, x + dx * cell, y + dy * cell) !== 0) === (value === 1),
    );
  });
}

describe('avatarOutlinePath', () => {
  it('draws nothing for an empty grid', () => {
    expect(avatarOutlinePath(grid(), 10)).toBe('');
  });

  it('refuses a grid that is not the avatar size', () => {
    expect(() => avatarOutlinePath(new Array<number>(AVATAR_CELLS - 1).fill(0), 10)).toThrow();
    expect(() => avatarOutlinePath(new Array<number>(AVATAR_CELLS + 1).fill(0), 10)).toThrow();
  });

  it('traces a lone cell clockwise from its top-left corner', () => {
    // One exact string, kept as the reading of the winding convention: right, down,
    // left, up is clockwise on screen, which is what makes holes subtract.
    expect(avatarOutlinePath(grid([0, 0]), 10)).toBe('M0 0L10 0L10 10L0 10Z');
  });

  it('merges collinear runs rather than emitting a corner per cell', () => {
    // Two cells side by side are ONE four-corner loop, not two rects and not six
    // points — the merge is what leaves no interior edge to seam.
    expect(loopsOf(avatarOutlinePath(grid([0, 0], [1, 0]), 10))).toEqual([
      [
        [0, 0],
        [20, 0],
        [20, 10],
        [0, 10],
      ],
    ]);
  });

  it('scales by the cell size', () => {
    for (const cell of [1, 4, 10, 37]) {
      expect(fills(grid([0, 0], [1, 1], [2, 0]), cell)).toBe(true);
    }
    expect(avatarOutlinePath(grid([0, 0]), 4)).toBe('M0 0L4 0L4 4L0 4Z');
  });

  it('cuts a hole as its own loop, wound the other way', () => {
    const ring = grid([0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2]);
    expect(fills(ring)).toBe(true);
    // Two loops, and the inner one winds counter-clockwise so nonzero subtracts it.
    const loops = loopsOf(avatarOutlinePath(ring, 10));
    expect(loops).toHaveLength(2);
    expect(winding(loops, 15, 15)).toBe(0); // the hole
    expect(winding(loops, 5, 5)).toBe(1); // the ring itself
  });

  it('keeps diagonally touching cells apart, both ways round', () => {
    // Both saddles: the two configurations take opposite branches of the walk's turn,
    // and getting one wrong merges the pair into one self-crossing loop.
    for (const saddle of [grid([0, 0], [1, 1]), grid([1, 0], [0, 1])]) {
      expect(fills(saddle)).toBe(true);
      expect(loopsOf(avatarOutlinePath(saddle, 10))).toHaveLength(2);
    }
  });

  it('walks a non-convex region as one loop', () => {
    const ell = grid([0, 0], [0, 1], [1, 1]);
    expect(fills(ell)).toBe(true);
    expect(loopsOf(avatarOutlinePath(ell, 10))).toHaveLength(1);
  });

  it('holds at the grid edges, where a cell has no neighbour to bound it', () => {
    const n = AVATAR_SIZE - 1;
    // A row's last cell and the next row's first are NOT neighbours, however adjacent
    // their flat indices look; a lost bound would weld them into one run.
    expect(fills(grid([n, 0], [0, 1]))).toBe(true);
    expect(fills(grid([n, n]))).toBe(true);
    // The whole border as a ring: every edge case at once, with a hole inside it.
    const border: Array<[number, number]> = [];
    for (let i = 0; i <= n; i++) {
      border.push([i, 0], [i, n], [0, i], [n, i]);
    }
    expect(fills(grid(...border))).toBe(true);
  });

  it('fills exactly the grid, over every 3×3 mask and a spread of full ones', () => {
    // Exhaustive over the 512 arrangements of a 3×3 block — every adjacency, saddle,
    // hole and island the walk can meet — placed where it touches the far edges.
    for (let mask = 0; mask < 512; mask++) {
      const on: Array<[number, number]> = [];
      for (let bit = 0; bit < 9; bit++) {
        if (mask & (1 << bit)) on.push([AVATAR_SIZE - 3 + (bit % 3), AVATAR_SIZE - 3 + ((bit / 3) | 0)]);
      }
      expect(fills(grid(...on))).toBe(true);
    }
    // Plus full-grid drawings, from a deterministic generator so a failure repeats.
    let seed = 0x9e3779b9;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    for (let round = 0; round < 300; round++) {
      const density = 0.15 + (round % 5) * 0.18;
      const cells = Array.from({ length: AVATAR_CELLS }, () => (next() < density ? 1 : 0));
      expect(fills(cells)).toBe(true);
    }
  });
});
