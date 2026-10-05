import { useEffect, useLayoutEffect, useRef, type MutableRefObject } from 'react';
import { AVATAR_PALETTES, AVATAR_SIZE } from '@whippin/shared';
import { prefersReducedMotion } from '../../hooks/useScramble';
import { canvasSide, cellStart, LINE_PX, paintPicture } from './picture';

// THE EDITOR'S CANVAS: the drawing as ONE raster (`picture.ts`: square cells on the 1px
// grid), and over it ONE overlay where every change is told — a painted cell POPS whole pixels
// proud and throws its eight sparks, an erased one shrinks into its middle, a fine pointer's
// cell wears a ring. Both are canvases at one raster pixel a CSS pixel, scaled up `pixelated`.
//
// WHY RASTERS: a fast drag paints a cell every few milliseconds, and a cell per element meant a
// remount, a style recalc and two pseudo-element animations (`inset`, `box-shadow`: layout and
// paint) per painted cell — the stroke stuttered on a phone. Here a paint is one array write:
// the picture is redrawn only when the drawing or its palette changes, and the overlay — its
// own layer, so the picture under it is never repainted — draws only while something on it is
// alive, on the animation clock, and stops.
//
// THE POP NEVER DECIDES WHAT THE CANVAS SHOWS: the picture is always exactly the cells held (a
// save stores what is on screen), and a pop is drawn only while its cell still holds the value
// it painted — a cell repainted under its own pop simply stops popping. Reduced motion draws no
// pop and no spark at all.
//
// A POP'S CLOCK STARTS ON THE CANVAS, not at the input: on the first overlay frame whose cells
// hold what it painted — the frame the picture first shows the cell in — so its biggest step
// shows whole however late the commit lands, as a CSS animation started on the frame that
// first styled the cell. Until then it WAITS, alive (a frame's time can read a hair before the
// input that asked for it: a pop not yet begun is never over), and one its cell never takes is
// let go a spark's life after it was asked for.

export type PopKind = 'in' | 'out';
export interface PaintFx {
  // These cells just changed, this way: each pops (a cell popping again restarts its pop).
  pop: (cells: readonly number[], kind: PopKind) => void;
  // Nothing pops any more (a drawing replaced wholesale pops nothing).
  clear: () => void;
}

// THE POP: three whole-pixel steps of 50ms — 6, 4, 2px proud, then the
// cell itself; erased: 4, 8, 12px in, then gone. The sparks: eight 4px squares of the ink, 14px
// out (10 on the diagonals), then 20 (14), then 26 (18) at 2px, a step every 100ms.
export const POP_MS = 150;
export const SPARK_MS = 300;
const POP_STEP_MS = 50;
const SPARK_STEP_MS = 100;
const POP_IN = [6, 4, 2] as const;
const POP_OUT = [4, 8, 12] as const;
const SPARK_AXIS = [14, 20, 26] as const;
const SPARK_DIAG = [10, 14, 18] as const;
const SPARK_SIZE = [4, 4, 2] as const;
// How far past the picture's edge anything is drawn, at this cell: an edge cell's pop, 6px
// proud, or a spark's furthest square from an edge cell's middle. The overlay's box is exactly
// that and no more — a canvas reaching past what it draws widens the page under a phone.
export function fxMargin(cell: number): number {
  const spark = Math.max(...SPARK_AXIS.map((reach, k) => reach + SPARK_SIZE[k] / 2));
  return Math.max(POP_IN[0], spark - (cell >> 1)) - LINE_PX;
}
const DIRECTIONS = [
  [0, -1, false],
  [1, -1, true],
  [1, 0, false],
  [1, 1, true],
  [0, 1, false],
  [-1, 1, true],
  [-1, 0, false],
  [-1, -1, true],
] as const;

export interface Pop {
  cell: number;
  kind: PopKind;
  // When the edit asked for it (the input's clock).
  born: number;
  // When its own clock started: the first frame whose cells held what it painted (null: not yet).
  at: number | null;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// What the overlay draws at `now` (pure): the rects of every live pop and spark, in the
// picture's coordinates, in the ink — none for a pop whose cell no longer holds what it painted
// — and the pops still LIVE, each clock started on the first frame whose cells hold it. The
// clock stops when none is.
export function popFrame(
  pops: readonly Pop[],
  cells: readonly number[],
  cell: number,
  now: number,
): { rects: Rect[]; live: Pop[] } {
  const rects: Rect[] = [];
  const live: Pop[] = [];
  for (const p of pops) {
    const held = cells[p.cell] === (p.kind === 'in' ? 1 : 0);
    if (p.at === null && !held) {
      if (now - p.born < SPARK_MS) live.push(p);
      continue;
    }
    const at = p.at ?? now;
    const t = Math.max(0, now - at);
    if (t >= (p.kind === 'in' ? SPARK_MS : POP_MS)) continue;
    live.push(p.at === at ? p : { ...p, at });
    if (!held) continue;
    const x0 = cellStart(p.cell % AVATAR_SIZE, cell);
    const y0 = cellStart(Math.floor(p.cell / AVATAR_SIZE), cell);
    if (t < POP_MS) {
      const step = Math.floor(t / POP_STEP_MS);
      const d = p.kind === 'in' ? -POP_IN[step] : POP_OUT[step];
      if (cell - 2 * d > 0) rects.push({ x: x0 + d, y: y0 + d, w: cell - 2 * d, h: cell - 2 * d });
    }
    if (p.kind === 'in') {
      const step = Math.floor(t / SPARK_STEP_MS);
      const size = SPARK_SIZE[step];
      const cx = x0 + (cell >> 1);
      const cy = y0 + (cell >> 1);
      for (const [dx, dy, diagonal] of DIRECTIONS) {
        const reach = diagonal ? SPARK_DIAG[step] : SPARK_AXIS[step];
        rects.push({ x: cx + dx * reach - size / 2, y: cy + dy * reach - size / 2, w: size, h: size });
      }
    }
  }
  return { rects, live };
}

export default function EditorCanvas({
  palette,
  cells,
  cell,
  fx,
  hover,
}: {
  palette: number;
  cells: readonly number[];
  // The cell's side, in whole px (odd: `picture.ts`).
  cell: number;
  // Where the screen tells the canvas what just changed.
  fx: MutableRefObject<PaintFx | null>;
  // The cell under a fine pointer, ringed (null: none).
  hover: number | null;
}) {
  const pictureRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const side = canvasSide(cell);
  const margin = fxMargin(cell);
  const room = side + 2 * margin;
  // The overlay reads, at every frame, what the last COMMIT holds — the cells the picture shows
  // — never what a render still in flight might.
  const live = useRef({ palette, cells, cell, hover });
  useLayoutEffect(() => {
    live.current = { palette, cells, cell, hover };
  });
  const pops = useRef<Pop[]>([]);
  const raf = useRef(0);

  const drawOverlay = useRef<(now: number) => boolean>(() => false);
  drawOverlay.current = (now: number) => {
    const canvas = overlayRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return false;
    const { palette: p, cells: c, cell: size, hover: h } = live.current;
    const m = fxMargin(size);
    const { rects, live: still } = popFrame(pops.current, c, size, now);
    pops.current = still;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // A fine pointer's cell, ringed in the white at 75% (2px, inside the cell) — UNDER the pops,
    // so a cell painted under the pointer pops clean over its ring.
    if (h !== null) {
      const x = m + cellStart(h % AVATAR_SIZE, size);
      const y = m + cellStart(Math.floor(h / AVATAR_SIZE), size);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.fillRect(x, y, size, 2);
      ctx.fillRect(x, y + size - 2, size, 2);
      ctx.fillRect(x, y + 2, 2, size - 4);
      ctx.fillRect(x + size - 2, y + 2, 2, size - 4);
    }
    ctx.fillStyle = AVATAR_PALETTES[p].fg;
    for (const r of rects) ctx.fillRect(m + r.x, m + r.y, r.w, r.h);
    return still.length > 0;
  };
  const tick = useRef<(now: number) => void>(() => {});
  tick.current = (now: number) => {
    raf.current = drawOverlay.current(now) ? requestAnimationFrame((t) => tick.current(t)) : 0;
  };
  const wake = () => {
    if (raf.current === 0) raf.current = requestAnimationFrame((t) => tick.current(t));
  };

  useEffect(() => {
    fx.current = {
      pop: (changed, kind) => {
        if (changed.length === 0 || prefersReducedMotion()) return;
        const born = performance.now();
        const fresh = new Set(changed);
        pops.current = pops.current.filter((p) => !fresh.has(p.cell));
        for (const i of changed) pops.current.push({ cell: i, kind, born, at: null });
        wake();
      },
      clear: () => {
        pops.current = [];
        wake();
      },
    };
    return () => {
      fx.current = null;
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, [fx]);

  // The picture: exactly the cells held, drawn in the commit that holds them.
  useLayoutEffect(() => {
    const canvas = pictureRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    if (canvas.width !== side) {
      canvas.width = side;
      canvas.height = side;
    }
    paintPicture(ctx, palette, cells, cell);
    // A pop of the ink must follow a new palette, and a pop over a cell repainted must stop.
    if (pops.current.length > 0) wake();
  }, [palette, cells, cell, side]);

  // The overlay's box follows the cell; the ring follows the pointer.
  useLayoutEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    if (canvas.width !== room) {
      canvas.width = room;
      canvas.height = room;
    }
    drawOverlay.current(performance.now());
  }, [room, hover]);

  return (
    <>
      <canvas ref={pictureRef} className="editor-picture" width={side} height={side} style={{ width: side, height: side }} aria-hidden="true" />
      <canvas
        ref={overlayRef}
        className="editor-fx"
        width={room}
        height={room}
        style={{ width: room, height: room, left: -margin, top: -margin }}
        aria-hidden="true"
      />
    </>
  );
}
