import { useEffect, useLayoutEffect, useRef } from 'react';
import { AVATAR_PALETTES, AVATAR_SIZE, bayerThreshold } from '@whippin/shared';
import { abgr, hexToAbgr } from '../raster';
import { prefersReducedMotion } from '../../hooks/useScramble';
import { speckOffset } from './tools';

// THE EDITOR'S PALETTE SWEEP: what the canvas WAS, laid over what it now is and swept off it on
// the diagonal through the house's ordered dither (`bayer.ts`, on the 2px cell) — the old
// picture's cells dropping out in threshold order behind a moving front, never a fade. A raster
// pixel a 2px cell, scaled up `pixelated`, laid exactly over the canvas (whose cell is a WHOLE,
// EVEN number of px, so the dither lands on the cells' own edges).
//
// The old picture is the canvas EXACTLY as it stood: its ground, its ink, and the grid's specks
// (`speckOffset`, the canvas's own rule: one in the middle of every empty cell). And a second
// tap while a sweep is still running CONTINUES from what is on screen: the half-swept picture —
// the older palette where the front has not passed, the newer one where it has — becomes the
// picture swept, the front starting over from the corner, so the newer palette is swept away in
// its turn rather than swapped in one frame.
//
// The overlay has NO box between sweeps (0 × 0: an unsized canvas would lay out at the
// browser's 300 × 150 and push the page sideways), and one is played only for a NEW shot — a
// resize mid-sweep ends it rather than replaying it at the new size. Reduced motion cuts
// straight to the new picture.
const CELL = 2;
const FRAME_MS = 40;
export const WIPE_MS = 420;
// The front's soft edge, in raster cells: how far behind it the old picture is gone.
const RAMP = 22;
// The grid's speck: the ink mixed 60% into the ground (the CSS's own `color-mix`).
const SPECK = 0.6;

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

// The canvas's picture, one entry per 2px raster cell: ground, ink, or the grid's speck.
export function canvasPicture(palette: number, cells: readonly number[], cellPx: number): Uint32Array {
  const side = cellPx * AVATAR_SIZE;
  const n = Math.ceil(side / CELL);
  const { bg, fg } = AVATAR_PALETTES[palette];
  const lo = hexToAbgr(bg);
  const hi = hexToAbgr(fg);
  const dot = mix(fg, bg, SPECK);
  const at0 = speckOffset(cellPx);
  const picture = new Uint32Array(n * n);
  for (let cy = 0; cy < n; cy += 1) {
    const py = cy * CELL;
    const ay = Math.min(AVATAR_SIZE - 1, Math.floor(py / cellPx));
    for (let cx = 0; cx < n; cx += 1) {
      const pxl = cx * CELL;
      const ax = Math.min(AVATAR_SIZE - 1, Math.floor(pxl / cellPx));
      const at = ay * AVATAR_SIZE + ax;
      const inked = cells[at] === 1;
      // The speck: the 2px at the middle of an empty cell.
      const speck = !inked && pxl === ax * cellPx + at0 && py === ay * cellPx + at0;
      picture[cy * n + cx] = inked ? hi : speck ? dot : lo;
    }
  }
  return picture;
}

interface Sweep {
  // What the overlay showed at its last frame (0 = swept), so a sweep started mid-sweep
  // carries on from the screen.
  px: Uint32Array;
  n: number;
  // Stop the frames: `clear` also empties the overlay and takes its box away.
  stop: (clear: boolean) => void;
}

export default function DitherWipe({ shot, cellPx }: { shot: WipeShot | null; cellPx: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const cell = useRef(cellPx);
  cell.current = cellPx;
  // The shot last played, so nothing but a NEW one plays.
  const played = useRef<number | null>(null);
  const running = useRef<Sweep | null>(null);

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas || !shot || shot.key === played.current) return;
    played.current = shot.key;
    const px0 = cell.current;
    if (prefersReducedMotion() || px0 <= 0) return;
    const n = Math.ceil((px0 * AVATAR_SIZE) / CELL);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // The picture swept: the canvas as it stood — or, mid-sweep, what is on screen of it.
    const picture = canvasPicture(shot.palette, shot.cells, px0);
    const was = running.current;
    if (was && was.n === n) {
      for (let i = 0; i < picture.length; i += 1) if (was.px[i] !== 0) picture[i] = was.px[i];
    }
    was?.stop(false);
    canvas.width = n;
    canvas.height = n;
    canvas.style.width = `${n * CELL}px`;
    canvas.style.height = `${n * CELL}px`;
    const image = ctx.createImageData(n, n);
    const px = new Uint32Array(image.data.buffer);
    const span = 2 * n;
    const t0 = performance.now();
    let raf = 0;
    let last = Number.NaN;
    const sweep: Sweep = {
      px,
      n,
      stop: (clear) => {
        cancelAnimationFrame(raf);
        if (running.current === sweep) running.current = null;
        if (!clear) return;
        canvas.width = 0;
        canvas.height = 0;
        canvas.style.width = '';
        canvas.style.height = '';
      },
    };
    running.current = sweep;
    const frame = (now: number) => {
      const ms = Math.max(0, now - t0);
      if (ms >= WIPE_MS) {
        sweep.stop(true);
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
  }, [shot]);

  // A new cell size mid-sweep: the overlay no longer fits the canvas — the sweep ends.
  useLayoutEffect(() => {
    running.current?.stop(true);
  }, [cellPx]);
  useEffect(() => () => running.current?.stop(true), []);

  return <canvas ref={ref} className="dither-wipe" width={0} height={0} aria-hidden="true" />;
}
