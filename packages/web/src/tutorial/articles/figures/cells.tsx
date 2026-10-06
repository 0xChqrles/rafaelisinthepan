import { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

// THE FIGURES' RASTER: the house's 2px CELL, drawn as the podium and the archive draw theirs —
// one canvas pixel a cell, blown up by exactly 2 with nearest-neighbour sampling
// (`image-rendering: pixelated`), so every line and every square lands on whole cells and
// nothing is anti-aliased at any device ratio. The inks are the app's TOKENS, read off the
// canvas's own computed style — never a hex of the figure's own.
export const CELL = 2;

export type Ink = 'fg' | 'muted' | 'rail' | 'accent' | 'bg';

export interface Cells {
  cols: number;
  rows: number;
  // One cell, in a token's ink (a cell off the raster is dropped).
  set(x: number, y: number, ink: Ink): void;
  // A w × h block of cells.
  block(x: number, y: number, w: number, h: number, ink: Ink): void;
}

// The cells of a straight line from one cell to another, end to end (Bresenham): a line in
// whole cells, stepping where it must, never a blend between two.
export function lineCells(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const out: [number, number][] = [];
  let x = Math.round(x0);
  let y = Math.round(y0);
  const xe = Math.round(x1);
  const ye = Math.round(y1);
  const dx = Math.abs(xe - x);
  const dy = -Math.abs(ye - y);
  const sx = x < xe ? 1 : -1;
  const sy = y < ye ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    out.push([x, y]);
    if (x === xe && y === ye) return out;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

// The box's width in whole CSS pixels, followed across a resize (0 until it is laid out).
export function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const read = () => setWidth(Math.floor(el.getBoundingClientRect().width));
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

const TOKEN: Record<Ink, string> = {
  fg: '--fg',
  muted: '--muted',
  rail: '--rail',
  accent: '--accent',
  bg: '--bg',
};

// A raster of `cols` × `rows` cells, painted by `draw` whenever `draw` changes (a caller's
// memo says when the picture does). Decorative: what it says is said in words beside it.
export function CellCanvas({
  cols,
  rows,
  draw,
  className,
}: {
  cols: number;
  rows: number;
  draw: (cells: Cells) => void;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || cols <= 0 || rows <= 0) return;
    if (canvas.width !== cols) canvas.width = cols;
    if (canvas.height !== rows) canvas.height = rows;
    ctx.clearRect(0, 0, cols, rows);
    const style = getComputedStyle(canvas);
    const inks = new Map<Ink, string>();
    const fill = (ink: Ink) => {
      let value = inks.get(ink);
      if (value === undefined) {
        value = style.getPropertyValue(TOKEN[ink]).trim() || '#fff';
        inks.set(ink, value);
      }
      ctx.fillStyle = value;
    };
    draw({
      cols,
      rows,
      set(x, y, ink) {
        if (x < 0 || y < 0 || x >= cols || y >= rows) return;
        fill(ink);
        ctx.fillRect(x, y, 1, 1);
      },
      block(x, y, w, h, ink) {
        fill(ink);
        ctx.fillRect(x, y, w, h);
      },
    });
  }, [cols, rows, draw]);
  return (
    <canvas
      ref={ref}
      className={`ar-cells${className ? ` ${className}` : ''}`}
      style={{ width: cols * CELL, height: rows * CELL }}
      aria-hidden="true"
    />
  );
}
