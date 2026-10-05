import { useLayoutEffect, useRef } from 'react';
import { AVATAR_PALETTES, AVATAR_SIZE, bayerThreshold } from '@whippin/shared';
import { abgr, hexToAbgr } from '../raster';
import { prefersReducedMotion } from '../../hooks/useScramble';

// THE EDITOR'S PALETTE SWEEP: what the canvas WAS, laid over what it now is and swept off it on
// the diagonal through the house's ordered dither (`bayer.ts`, on the 2px cell) — the old
// picture's cells dropping out in threshold order behind a moving front, never a fade. A raster
// pixel a 2px cell, scaled up `pixelated`, laid exactly over the canvas (whose cell is a WHOLE,
// EVEN number of px, so the dither lands on the cells' own edges).
//
// The old picture is the canvas EXACTLY as it stood: its ground, its ink, and the speck of ink
// in each empty cell's corner that is the grid. And a second tap while a sweep is still
// running CONTINUES from what is on screen — the half-swept picture, older palette and newer
// together — rather than snapping to the newer one first.
//
// Reduced motion cuts straight to the new picture.
const CELL = 2;
const FRAME_MS = 40;
const WIPE_MS = 420;
// The front's soft edge, in raster cells: how far behind it the old picture is gone.
const RAMP = 22;
// The grid's speck: the ink mixed 42% into the ground (the CSS's own `color-mix`).
const SPECK = 0.42;

export interface WipeShot {
  // What the canvas showed: its palette and its cells.
  palette: number;
  cells: readonly number[];
  // A new key plays a new sweep.
  key: number;
}

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
function mix(fg: string, bg: string, k: number): number {
  const a = channels(fg);
  const b = channels(bg);
  const [r, g, bl] = a.map((v, i) => Math.round(v * k + b[i] * (1 - k)));
  return abgr(r, g, bl);
}

// The canvas's picture, one entry per 2px raster cell: ground, ink, or the corner speck.
export function canvasPicture(palette: number, cells: readonly number[], cellPx: number): Uint32Array {
  const side = cellPx * AVATAR_SIZE;
  const n = Math.ceil(side / CELL);
  const { bg, fg } = AVATAR_PALETTES[palette];
  const lo = hexToAbgr(bg);
  const hi = hexToAbgr(fg);
  const dot = mix(fg, bg, SPECK);
  const picture = new Uint32Array(n * n);
  for (let cy = 0; cy < n; cy += 1) {
    const py = cy * CELL;
    const ay = Math.min(AVATAR_SIZE - 1, Math.floor(py / cellPx));
    for (let cx = 0; cx < n; cx += 1) {
      const pxl = cx * CELL;
      const ax = Math.min(AVATAR_SIZE - 1, Math.floor(pxl / cellPx));
      const inked = cells[ay * AVATAR_SIZE + ax] === 1;
      // The speck: the empty cell's top-left 2px, but never on the canvas's own edge (the
      // grid's lines are inside it).
      const speck = !inked && ax > 0 && ay > 0 && pxl === ax * cellPx && py === ay * cellPx;
      picture[cy * n + cx] = inked ? hi : speck ? dot : lo;
    }
  }
  return picture;
}

export default function DitherWipe({ shot, cellPx }: { shot: WipeShot | null; cellPx: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  // What the overlay showed at its last frame (0 = swept), so a sweep started mid-sweep
  // carries on from the screen.
  const shown = useRef<{ px: Uint32Array; n: number; live: boolean } | null>(null);

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas || !shot || prefersReducedMotion() || cellPx <= 0) return undefined;
    const n = Math.ceil((cellPx * AVATAR_SIZE) / CELL);
    canvas.width = n;
    canvas.height = n;
    canvas.style.width = `${n * CELL}px`;
    canvas.style.height = `${n * CELL}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    const image = ctx.createImageData(n, n);
    const px = new Uint32Array(image.data.buffer);
    const picture = canvasPicture(shot.palette, shot.cells, cellPx);
    // Mid-sweep: what is still standing of the older picture stays over the newer one.
    const was = shown.current;
    if (was && was.live && was.n === n) {
      for (let i = 0; i < picture.length; i += 1) if (was.px[i] !== 0) picture[i] = was.px[i];
    }
    shown.current = { px, n, live: true };
    const span = 2 * n;
    const t0 = performance.now();
    let raf = 0;
    let last = -1;
    const frame = (now: number) => {
      const ms = now - t0;
      if (ms >= WIPE_MS) {
        px.fill(0);
        ctx.clearRect(0, 0, n, n);
        if (shown.current) shown.current.live = false;
        return;
      }
      const step = Math.floor(ms / FRAME_MS);
      if (step !== last) {
        last = step;
        const k = (step * FRAME_MS) / WIPE_MS;
        const front = -RAMP + k * (span + 2 * RAMP);
        for (let cy = 0; cy < n; cy += 1) {
          for (let cx = 0; cx < n; cx += 1) {
            const swept = Math.min(1, Math.max(0, (front - (cx + cy)) / RAMP));
            const i = cy * n + cx;
            px[i] = swept > bayerThreshold(cx, cy) ? 0 : picture[i];
          }
        }
        ctx.putImageData(image, 0, 0);
      }
      raf = requestAnimationFrame(frame);
    };
    // The first frame at once: the old picture stands over the new from the very commit.
    frame(t0);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [shot?.key, cellPx]);

  return <canvas ref={ref} className="dither-wipe" aria-hidden="true" />;
}
