// The profile editor's tools (components/editor/tools.ts): a stroke's line between two pointer
// samples, the dice's roll (a NEW SHAPE, the assigned way, the palette KEPT) and CLEAR's drain
// — each a rule the editor's behaviour rests on, asserted against what the editor promises
// rather than how it draws.

import { describe, expect, it } from 'vitest';
import { AVATAR_CELLS, PUBLIC_ID_PATTERN, decodeAvatar, defaultAvatar } from '@whippin/shared';
import { DICE_MIN_INK, cellLine, churnCells, drainStep, landStep, paintStroke, rollShape } from './tools';

const blank = () => new Array<number>(AVATAR_CELLS).fill(0);
const at = (x: number, y: number) => y * 10 + x;
// A drawing that is its own left-right mirror image — what every assigned mark is.
const isSymmetric = (cells: readonly number[]) => cells.every((v, i) => v === cells[Math.floor(i / 10) * 10 + (9 - (i % 10))]);
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
    const { cells: next, changed } = paintStroke(cells, cellLine(at(1, 2), at(4, 2)), 1);
    expect(changed).toEqual([at(1, 2), at(2, 2), at(4, 2)]);
    expect([1, 2, 3, 4].every((x) => next[at(x, 2)] === 1)).toBe(true);
    expect(cells[at(1, 2)]).toBe(0); // the input is never mutated
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

  it('churns plausible creatures (mirrored) and lands the shape over the churn in the Bayer order', () => {
    for (let f = 0; f < 6; f += 1) expect(isSymmetric(churnCells(f))).toBe(true);
    const target = rollShape(blank(), seeded(9));
    let shown = churnCells(4);
    const changed = new Set<number>();
    let left = shown.filter((v, i) => v !== target[i]).length;
    for (let step = 1; step <= 6; step += 1) {
      const out = landStep(shown, target, step, 6);
      // Each step changes only cells that differ from the shape, each once, into the shape.
      for (const i of out.on) expect(target[i]).toBe(1);
      for (const i of out.off) expect(target[i]).toBe(0);
      for (const i of [...out.on, ...out.off]) {
        expect(changed.has(i)).toBe(false);
        changed.add(i);
      }
      const now = out.cells.filter((v, i) => v !== target[i]).length;
      expect(now).toBeLessThanOrEqual(left);
      left = now;
      shown = out.cells;
    }
    expect(shown).toEqual(target);
    // The first step lands a scattered few, never a block from one edge.
    const first = landStep(new Array<number>(AVATAR_CELLS).fill(0), new Array<number>(AVATAR_CELLS).fill(1), 1, 6).on;
    expect(first.length).toBeGreaterThan(8);
    expect(first.length).toBeLessThan(30);
    expect(new Set(first.map((i) => Math.floor(i / 10))).size).toBeGreaterThanOrEqual(5);
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
