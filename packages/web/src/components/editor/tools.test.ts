// The profile editor's tools (components/editor/tools.ts): the mirror's twin and its symmetry
// test, a stroke's line between two pointer samples, the dice's roll (a NEW SHAPE, the
// assigned way, the palette KEPT) and CLEAR's drain — each a rule the editor's behaviour rests
// on, asserted against what the editor promises rather than how it draws.

import { describe, expect, it } from 'vitest';
import { AVATAR_CELLS, PUBLIC_ID_PATTERN, decodeAvatar, defaultAvatar } from '@whippin/shared';
import {
  DICE_MIN_INK,
  cellLine,
  churnCells,
  drainStep,
  isSymmetric,
  landingOrder,
  mirroredCell,
  paintStroke,
  rollShape,
  speckAt,
} from './tools';

const blank = () => new Array<number>(AVATAR_CELLS).fill(0);
const at = (x: number, y: number) => y * 10 + x;
// A seeded source of public-id-shaped seeds, so a roll is reproducible in a test.
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
function seeded(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
  return () => Array.from({ length: 16 }, () => ALPHABET[Math.floor(next() * ALPHABET.length)]).join('');
}

describe('the mirror', () => {
  it("pairs each cell with its twin across the vertical midline, never itself", () => {
    expect(mirroredCell(at(0, 0))).toBe(at(9, 0));
    expect(mirroredCell(at(4, 7))).toBe(at(5, 7));
    for (let i = 0; i < AVATAR_CELLS; i += 1) {
      expect(mirroredCell(mirroredCell(i))).toBe(i);
      expect(mirroredCell(i)).not.toBe(i);
    }
  });

  it('calls every assigned mark symmetric (so the editor opens with MIRROR on)', () => {
    for (const id of ['aaaaaaaaaaaaaaaa', 'zz23zz45zz67zzab', 'qwertyuiopasdfgh']) {
      expect(isSymmetric(decodeAvatar(defaultAvatar(id)).cells)).toBe(true);
    }
  });

  it('calls a lopsided drawing asymmetric, and the blank one symmetric', () => {
    const cells = blank();
    expect(isSymmetric(cells)).toBe(true);
    cells[at(1, 1)] = 1;
    expect(isSymmetric(cells)).toBe(false);
    cells[at(8, 1)] = 1;
    expect(isSymmetric(cells)).toBe(true);
  });
});

describe('the grid', () => {
  it('specks a crossing only where all four cells meeting there are empty, never on the edge', () => {
    const cells = blank();
    expect(speckAt(cells, at(0, 0))).toBe(false);
    expect(speckAt(cells, at(5, 0))).toBe(false);
    expect(speckAt(cells, at(0, 5))).toBe(false);
    expect(speckAt(cells, at(5, 5))).toBe(true);
    cells[at(4, 4)] = 1;
    // The four crossings at the inked cell's corners carry no speck: none touches the ink.
    expect(speckAt(cells, at(4, 4))).toBe(false);
    expect(speckAt(cells, at(5, 4))).toBe(false);
    expect(speckAt(cells, at(4, 5))).toBe(false);
    expect(speckAt(cells, at(5, 5))).toBe(false);
    expect(speckAt(cells, at(6, 6))).toBe(true);
  });
});

describe('a stroke', () => {
  it('fills every cell between two samples, both ends included, with no gap', () => {
    const line = cellLine(at(0, 0), at(9, 3));
    expect(line[0]).toBe(at(0, 0));
    expect(line[line.length - 1]).toBe(at(9, 3));
    // Each step moves to a neighbouring cell (8-connected): a fast drag leaves no hole.
    for (let k = 1; k < line.length; k += 1) {
      const dx = Math.abs((line[k] % 10) - (line[k - 1] % 10));
      const dy = Math.abs(Math.floor(line[k] / 10) - Math.floor(line[k - 1] / 10));
      expect(Math.max(dx, dy)).toBe(1);
    }
    expect(cellLine(at(3, 3), at(3, 3))).toEqual([at(3, 3)]);
    expect(cellLine(at(2, 5), at(6, 5))).toEqual([at(2, 5), at(3, 5), at(4, 5), at(5, 5), at(6, 5)]);
  });

  it('paints its one value and reports only the cells it changed', () => {
    const cells = blank();
    cells[at(3, 2)] = 1;
    const { cells: next, changed } = paintStroke(cells, cellLine(at(1, 2), at(4, 2)), 1, false);
    expect(changed).toEqual([at(1, 2), at(2, 2), at(4, 2)]);
    expect([1, 2, 3, 4].every((x) => next[at(x, 2)] === 1)).toBe(true);
    expect(cells[at(1, 2)]).toBe(0); // the input is never mutated
  });

  it('paints every twin with the mirror on, so a symmetric drawing stays symmetric', () => {
    const { cells, changed } = paintStroke(blank(), [at(1, 4), at(2, 4)], 1, true);
    expect(cells[at(8, 4)]).toBe(1);
    expect(cells[at(7, 4)]).toBe(1);
    expect(changed).toHaveLength(4);
    expect(isSymmetric(cells)).toBe(true);
    // Erasing with the mirror takes the twin away too.
    const erased = paintStroke(cells, [at(1, 4)], 0, true).cells;
    expect(erased[at(8, 4)]).toBe(0);
    expect(isSymmetric(erased)).toBe(true);
  });

  it('counts a cell and its twin once when the stroke crosses the axis', () => {
    const { changed } = paintStroke(blank(), cellLine(at(3, 0), at(6, 0)), 1, true);
    expect(new Set(changed).size).toBe(changed.length);
    expect(changed).toHaveLength(4);
  });
});

describe('the dice', () => {
  it("rolls the ASSIGNED derivation of a public-id-shaped seed — the shape only", () => {
    const ids: string[] = [];
    const source = seeded(1);
    const cells = rollShape(blank(), () => {
      const id = source();
      ids.push(id);
      return id;
    });
    for (const id of ids) expect(id).toMatch(PUBLIC_ID_PATTERN);
    // The cells of the last seed asked for, and nothing else (no palette rides with them).
    expect(cells).toEqual(decodeAvatar(defaultAvatar(ids[ids.length - 1])).cells);
    expect(cells).toHaveLength(AVATAR_CELLS);
  });

  it('rolls from the shared id generator by default', () => {
    const cells = rollShape(blank());
    expect(isSymmetric(cells)).toBe(true);
    expect(cells.reduce((s, v) => s + v, 0)).toBeGreaterThanOrEqual(DICE_MIN_INK);
  });

  it("rolls a shape the assigned way: symmetric, its outer columns empty, never near-empty", () => {
    const random = seeded(42);
    for (let k = 0; k < 40; k += 1) {
      const cells = rollShape(blank(), random);
      expect(isSymmetric(cells)).toBe(true);
      expect(cells.reduce((s, v) => s + v, 0)).toBeGreaterThanOrEqual(DICE_MIN_INK);
      for (let y = 0; y < 10; y += 1) {
        expect(cells[at(0, y)]).toBe(0);
        expect(cells[at(9, y)]).toBe(0);
      }
    }
  });

  it('never rolls the shape already on screen', () => {
    const random = seeded(3);
    const first = rollShape(blank(), random);
    // A source that would answer the same seed again still lands somewhere else.
    let replay = 0;
    const stuck = () => {
      replay += 1;
      return replay <= 16 ? seeded(3)() : random();
    };
    expect(rollShape(first, stuck)).not.toEqual(first);
  });

  it('churns plausible creatures (mirrored) and lands every cell exactly once', () => {
    for (let f = 0; f < 6; f += 1) expect(isSymmetric(churnCells(f))).toBe(true);
    const order = landingOrder(rollShape(blank(), seeded(9)));
    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: AVATAR_CELLS }, (_, i) => i));
  });
});

describe('clear', () => {
  it('drains the ink in the Bayer order, thinning evenly, and empties on its last step', () => {
    const full = new Array<number>(AVATAR_CELLS).fill(1);
    let cells = full;
    const gone: number[] = [];
    let previous = AVATAR_CELLS;
    for (let step = 1; step <= 6; step += 1) {
      const out = drainStep(cells, step, 6);
      const left = out.cells.reduce((s, v) => s + v, 0);
      expect(left).toBeLessThan(previous);
      previous = left;
      gone.push(...out.gone);
      cells = out.cells;
    }
    expect(previous).toBe(0);
    expect(new Set(gone).size).toBe(AVATAR_CELLS);
    // The first step takes a scattered sixth, never a block from one edge.
    const first = drainStep(full, 1, 6).gone;
    expect(first.length).toBeGreaterThan(8);
    expect(first.length).toBeLessThan(30);
    expect(new Set(first.map((i) => Math.floor(i / 10))).size).toBeGreaterThanOrEqual(5);
    expect(new Set(first.map((i) => i % 10)).size).toBeGreaterThanOrEqual(5);
  });

  it('leaves the ground alone', () => {
    const cells = blank();
    cells[at(5, 5)] = 1;
    const out = drainStep(cells, 6, 6);
    expect(out.gone).toEqual([at(5, 5)]);
    expect(out.cells.every((v) => v === 0)).toBe(true);
  });
});
