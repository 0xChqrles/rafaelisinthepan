import { useEffect, useLayoutEffect, useRef } from 'react';
import { bayerThreshold } from '@whippin/shared';
import { prefersReducedMotion } from '../../hooks/useScramble';
import { canvasPicture, canvasSide, ditherCell } from './picture';

// THE EDITOR'S PALETTE SWEEP: what the canvas WAS, laid over what it now is and swept off it on
// the diagonal through the house's ordered dither (`bayer.ts`, on the 2px cell) — the old
// picture dropping out in threshold order behind a moving front, never a fade. One raster pixel
// a CSS pixel, scaled up `pixelated`, laid exactly over the canvas.
//
// The old picture is the canvas EXACTLY as it stood (`canvasPicture`, the canvas's own: its
// ground, its ink, its grid's lines), and the dither's 2px cells are the canvas's own
// (`ditherCell`), so the sweep never cuts a cell off-grid. A second tap while a sweep is still
// running CONTINUES from what is on screen: the half-swept picture — the older palette where the
// front has not passed, the newer one where it has — becomes the picture swept, the front
// starting over from the corner, so the newer palette is swept away in its turn rather than
// swapped in one frame.
//
// The overlay has NO box between sweeps (0 × 0: an unsized canvas would lay out at the
// browser's 300 × 150 and push the page sideways), and one is played only for a NEW shot — a
// resize mid-sweep ends it rather than replaying it at the new size. Reduced motion cuts
// straight to the new picture.
const FRAME_MS = 40;
export const WIPE_MS = 420;
// The front's soft edge, in dither cells: how far behind it the old picture is gone.
const RAMP = 22;

export interface WipeShot {
  // What the canvas showed: its palette and its cells.
  palette: number;
  cells: readonly number[];
  // A new key plays a new sweep.
  key: number;
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
    const n = canvasSide(px0);
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
    canvas.style.width = `${n}px`;
    canvas.style.height = `${n}px`;
    const image = ctx.createImageData(n, n);
    const px = new Uint32Array(image.data.buffer);
    // Each pixel's dither cell, along one axis, and the front's whole run across them.
    const cellOf = Array.from({ length: n }, (_, i) => ditherCell(i));
    const span = 2 * (cellOf[n - 1] + 1);
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
        for (let y = 0; y < n; y += 1) {
          const by = cellOf[y];
          for (let x = 0; x < n; x += 1) {
            const bx = cellOf[x];
            const swept = Math.min(1, Math.max(0, (front - (bx + by)) / RAMP));
            const i = y * n + x;
            px[i] = swept > bayerThreshold(bx, by) ? 0 : picture[i];
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
