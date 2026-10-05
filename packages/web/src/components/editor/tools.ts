import {
  AVATAR_CELLS,
  AVATAR_SIZE,
  T0,
  bayerThreshold,
  decodeAvatar,
  defaultAvatar,
  generatePublicId,
  noise3,
} from '@whippin/shared';

// THE EDITOR'S TOOLS, PURE (`screens/Profile.tsx` draws them): what a stroke paints, what the
// MIRROR adds to it, what the DICE rolls and what CLEAR takes away at each of its steps — over
// the mark's 100 cells (row-major, 0 = ground, 1 = ink), never over its palette. Nothing here
// decides what is SAVED: every tool is an ordinary edit, and SAVE stays the deploy.

// ── The mirror ────────────────────────────────────────────────────────────────────────────
// A cell's twin across the mark's vertical midline (a cell on a 10-wide grid has no cell of
// its own on the axis: every twin is another cell).
export const mirroredCell = (i: number): number =>
  Math.floor(i / AVATAR_SIZE) * AVATAR_SIZE + (AVATAR_SIZE - 1 - (i % AVATAR_SIZE));

// Is a drawing its own left-right mirror image? Every ASSIGNED mark is (`defaultAvatar` walks
// the left half and mirrors it) — which is why the editor opens with MIRROR ON for a symmetric
// drawing, and OFF for one a player has made lopsided on purpose.
export const isSymmetric = (cells: readonly number[]): boolean =>
  cells.every((value, i) => value === cells[mirroredCell(i)]);

// ── The grid ──────────────────────────────────────────────────────────────────────────────
// Where the canvas shows its GRID: a 2px speck of the ink at the MIDDLE of every empty cell — a
// regular lattice of places to paint, the outer ring included, and never touching a drawn cell
// (the speck stays inside its own). Its offset in the cell is a whole, EVEN number of px, so it
// lands on the house's 2px dither too (the palette sweep's snapshot draws it on that grid):
// the middle exactly where the cell's half is odd, a pixel short of it where it is even.
export const speckOffset = (cellPx: number): number => Math.max(0, 2 * Math.floor((cellPx / 2 - 1) / 2));

// ── A stroke ──────────────────────────────────────────────────────────────────────────────
// The cells on the line from cell `a` to cell `b` (Bresenham), both ends included: a stroke's
// path between two pointer samples, so a fast drag leaves no gap between the cells it crossed.
export function cellLine(a: number, b: number): number[] {
  let x0 = a % AVATAR_SIZE;
  let y0 = Math.floor(a / AVATAR_SIZE);
  const x1 = b % AVATAR_SIZE;
  const y1 = Math.floor(b / AVATAR_SIZE);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  const out: number[] = [];
  for (;;) {
    out.push(y0 * AVATAR_SIZE + x0);
    if (x0 === x1 && y0 === y1) return out;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

// Paint `value` (the stroke's ONE value: a gesture that starts on ink erases) into `path`, and
// — with the mirror on — into every cell's twin too. Answers the drawing after the stroke and
// the cells that actually CHANGED (in the order painted, each once): the cells that pop.
export function paintStroke(
  cells: readonly number[],
  path: readonly number[],
  value: 0 | 1,
  mirror: boolean,
): { cells: number[]; changed: number[] } {
  const changed: number[] = [];
  const seen = new Set<number>();
  for (const at of path) {
    for (const i of mirror ? [at, mirroredCell(at)] : [at]) {
      if (seen.has(i)) continue;
      seen.add(i);
      if (cells[i] !== value) changed.push(i);
    }
  }
  if (changed.length === 0) return { cells: [...cells], changed };
  const next = [...cells];
  for (const i of changed) next[i] = value;
  return { cells: next, changed };
}

// ── The dice ──────────────────────────────────────────────────────────────────────────────
// A fresh SHAPE, the assigned way: `defaultAvatar`'s own derivation (a creature walked over the
// left half and mirrored, its outer ring empty) for a fresh id of the public id's shape (the
// shared generator, so the seed is exactly what an account's would be) — its CELLS only. The
// palette is the player's choice and the dice never touches it.
// A roll that came up nearly empty is rolled again: a mark of a handful of cells reads as a
// broken one, never as a creature.
export const DICE_MIN_INK = 12;

export function rollShape(current: readonly number[], nextId: () => string = generatePublicId): number[] {
  for (let tries = 0; ; tries += 1) {
    const { cells } = decodeAvatar(defaultAvatar(nextId()));
    const ink = cells.reduce((sum, v) => sum + v, 0);
    const same = cells.every((v, i) => v === current[i]);
    // (A source that keeps answering the same seed would spin forever: after enough tries,
    // any shape that is not the one on screen will do.)
    if (!same && (ink >= DICE_MIN_INK || tries > 64)) return cells;
  }
}

// One frame of the dice's CHURN: the waiting tile's noise (`AccountMark`'s recipe — one octave
// of value noise sampled about the midline, so every frame is a plausible creature), but fast:
// the dice is rattling, not waiting.
const CHURN_SCALE = 1;
const CHURN_THRESHOLD = 0.57;
export function churnCells(frame: number): number[] {
  const out = new Array<number>(AVATAR_CELLS).fill(0);
  const t = T0 + frame * 0.9;
  for (let y = 0; y < AVATAR_SIZE; y += 1) {
    for (let x = 0; x < AVATAR_SIZE; x += 1) {
      const mx = x < AVATAR_SIZE / 2 ? x : AVATAR_SIZE - 1 - x;
      out[y * AVATAR_SIZE + x] = noise3(mx * CHURN_SCALE, y * CHURN_SCALE, t) > CHURN_THRESHOLD ? 1 : 0;
    }
  }
  return out;
}

// The rolled shape LANDS out of the churn in the Bayer order — CLEAR's drain run the other way:
// at step `step` of `steps`, every cell whose threshold is under step/steps takes the shape's
// value, so the new mark settles evenly over the frozen churn, never from one edge, and the
// last step leaves exactly the shape. `on`/`off` are the cells that step changed, each with its
// own pop.
export function landStep(
  shown: readonly number[],
  target: readonly number[],
  step: number,
  steps: number,
): { cells: number[]; on: number[]; off: number[] } {
  const level = step / steps;
  const on: number[] = [];
  const off: number[] = [];
  const cells = shown.map((v, i) => {
    const lands = step >= steps || bayerThreshold(i % AVATAR_SIZE, Math.floor(i / AVATAR_SIZE)) < level;
    if (!lands || v === target[i]) return v;
    (target[i] === 1 ? on : off).push(i);
    return target[i];
  });
  return { cells, on, off };
}

// ── Clear ─────────────────────────────────────────────────────────────────────────────────
// CLEAR DRAINS in the Bayer order: at step `step` of `steps`, every inked cell whose threshold
// is under step/steps is gone — so the drawing thins evenly, never wiped from one edge, and
// the last step leaves the ground alone.
export function drainStep(cells: readonly number[], step: number, steps: number): { cells: number[]; gone: number[] } {
  const level = step / steps;
  const gone: number[] = [];
  const next = cells.map((v, i) => {
    if (v === 1 && (step >= steps || bayerThreshold(i % AVATAR_SIZE, Math.floor(i / AVATAR_SIZE)) < level)) {
      gone.push(i);
      return 0;
    }
    return v;
  });
  return { cells: next, gone };
}
