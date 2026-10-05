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
// Where the canvas shows its GRID: a speck of the ink at a grid crossing, drawn in the corner of
// the cell below-right of it — and only where all FOUR cells meeting there are empty, so a
// speck never touches a drawn cell (a speck glued to the ink's edge reads as a stray pixel of
// the drawing). The canvas's own edge carries none: the grid's lines are inside the mark.
export function speckAt(cells: readonly number[], i: number): boolean {
  const x = i % AVATAR_SIZE;
  const y = Math.floor(i / AVATAR_SIZE);
  if (x === 0 || y === 0) return false;
  return cells[i] !== 1 && cells[i - 1] !== 1 && cells[i - AVATAR_SIZE] !== 1 && cells[i - AVATAR_SIZE - 1] !== 1;
}

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

// The order a rolled shape LANDS in out of the churn: a deterministic shuffle seeded by the
// shape, so a re-render mid-roll cannot re-scatter the cells that have already landed.
export function landingOrder(cells: readonly number[]): number[] {
  let state = 0x811c9dc5;
  for (let i = 0; i < cells.length; i += 1) state = (Math.imul(state ^ (cells[i] + 1 + i), 0x01000193) >>> 0) || 1;
  const order = Array.from({ length: cells.length }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
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
