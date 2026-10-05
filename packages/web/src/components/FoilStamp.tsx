import { useEffect, useRef } from 'react';
import { getLuminance } from 'polished';
import {
  AVATAR_PALETTES,
  AVATAR_SIZE,
  FOIL_WHITE,
  bayerThreshold,
  decodeAvatar,
  foilCells,
  foilGlitter,
  foilInkRgb,
} from '@whippin/shared';
import { abgr } from './raster';
import { prefersReducedMotion } from '../hooks/useScramble';

// THE FOIL STAMP — a mark being SAVED, in the app's one shiny material (shared `foil.ts`, the
// result's count and every given word): a wide band of holographic foil SWEEPS the mark on its
// diagonal, the mark's INK holds in foil behind it with the glitter's stars, then the foil
// DISSOLVES back into the ink cell by cell in the Bayer order — the charge meter's recede — and
// the mark is its own two colours again. It never rests on a mark: a mark is the player's.
//
//   SWEEP  STAMP_SWEEP_MS  the band crosses, top-left to bottom-right
//   HOLD   STAMP_HOLD_MS   the ink stands in foil, glittering
//   RECEDE STAMP_RECEDE_MS the foil goes back into the ink in STAMP_STEPS hard steps
//
//   <FoilStamp play={n} avatar={encoded} />
//
// sits inside the mark's own box (any `position: relative` square of any whole-pixel size —
// the editor's canvas, the email flow's 80px ending face); each new positive `play` plays one
// stamp.
//
// `avatar` (the encoded mark) says where the INK is — its cells keep the foil behind the band;
// without one the whole box is foil. The grain is the house's 2px cell where the mark's own
// cell divides by it, else the mark's cell itself (a 50px mark's 5px pixels turn to foil one
// whole pixel at a time) — never a foil cell straddling two of the mark's. Reduced motion
// plays nothing: the save is told by the button.
//
// THE FOIL IS PASTEL, so on a LIGHT ground (the mark's palette's, over LIGHT_GROUND) it would
// read as the drawing fading out: there the ink holds in the DEEP foil instead — the same
// inks pressed toward the streak link's under-face navy (`FOIL_DEEP`) — and stays darker than
// its ground; the glitter's stars stay white on it.
export const STAMP_SWEEP_MS = 460;
export const STAMP_HOLD_MS = 340;
export const STAMP_RECEDE_MS = 360;
export const STAMP_MS = STAMP_SWEEP_MS + STAMP_HOLD_MS + STAMP_RECEDE_MS;
const STAMP_STEPS = 8;
const BAND = 0.3;
const FRAME_MS = 40;
const GLITTER = 0.03;
const LIGHT_GROUND = 0.5;
const DEEP_RGB = [28, 37, 102] as const; // the streak sprites' FOIL_DEEP, #1c2566
const DEEP_MIX = 0.55;

export interface StampOptions {
  // The encoded mark the box shows: its ink keeps the foil. Omitted: the whole box.
  avatar?: string | null;
  // The foil's own picture (`foilSeed`): every surface its own.
  seed?: number;
  // Told when the stamp is over (or cut short).
  onDone?: () => void;
}

const smooth = (k: number) => k * k * (3 - 2 * k);
const WHITE = abgr(255, 255, 255);
const inks = new Map<number, number>();
function inkOf(ink: number, deep: boolean): number {
  if (ink === FOIL_WHITE && !deep) return WHITE;
  const key = deep ? -2 - ink : ink;
  let hit = inks.get(key);
  if (hit === undefined) {
    const rgb = foilInkRgb(ink);
    const [r, g, b] = deep ? rgb.map((c, j) => Math.round(c * (1 - DEEP_MIX) + DEEP_RGB[j] * DEEP_MIX)) : rgb;
    hit = abgr(r, g, b);
    inks.set(key, hit);
  }
  return hit;
}

// The ink cells of a mark, or null for "the whole box"; and whether its ground is light.
function markOf(avatar: string | null | undefined): { cells: readonly number[] | null; deep: boolean } {
  if (!avatar) return { cells: null, deep: false };
  try {
    const { palette, cells } = decodeAvatar(avatar);
    return { cells, deep: getLuminance(AVATAR_PALETTES[palette].bg) > LIGHT_GROUND };
  } catch {
    return { cells: null, deep: false };
  }
}

// The grain for a box `side` px wide holding a 10-cell mark (see the header).
export function stampGrain(side: number, marked: boolean): number {
  if (!marked) return 2;
  const cell = side / AVATAR_SIZE;
  if (!Number.isInteger(cell)) return 2;
  return cell % 2 === 0 ? 2 : cell % 3 === 0 ? 3 : cell;
}

// THE PAINTER: one stamp on `canvas`, over a (w × h) box, from now; returns a cancel.
function paintStamp(
  canvas: HTMLCanvasElement,
  w: number,
  h: number,
  cells: readonly number[] | null,
  deep: boolean,
  seed: number,
  onDone: () => void,
): () => void {
  const grain = stampGrain(Math.min(w, h), cells !== null);
  const cols = Math.ceil(w / grain);
  const rows = Math.ceil(h / grain);
  canvas.width = cols;
  canvas.height = rows;
  canvas.style.width = `${cols * grain}px`;
  canvas.style.height = `${rows * grain}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    onDone();
    return () => {};
  }
  const image = ctx.createImageData(cols, rows);
  const px = new Uint32Array(image.data.buffer);
  const cellW = w / AVATAR_SIZE;
  const cellH = h / AVATAR_SIZE;
  const ink = (x: number, y: number) =>
    cells === null ||
    cells[Math.min(AVATAR_SIZE - 1, Math.floor(y / cellH)) * AVATAR_SIZE + Math.min(AVATAR_SIZE - 1, Math.floor(x / cellW))] === 1;
  const dy = h * 0.9;
  const diag = w * w + dy * dy;
  const t0 = performance.now();
  const since = t0 / 1000;
  let raf = 0;
  let lastStep = -1;
  let over = false;
  const finish = () => {
    if (over) return;
    over = true;
    cancelAnimationFrame(raf);
    ctx.clearRect(0, 0, cols, rows);
    onDone();
  };
  const frame = (now: number) => {
    const ms = now - t0;
    if (ms >= STAMP_MS) {
      finish();
      return;
    }
    const step = Math.floor(ms / FRAME_MS);
    if (step !== lastStep) {
      lastStep = step;
      const at = step * FRAME_MS;
      const k = Math.min(1, at / STAMP_SWEEP_MS);
      const centre = -BAND + smooth(k) * (1 + 2 * BAND);
      // The foil left on the ink: whole until the recede, then thinning in hard steps.
      const recedeAt = STAMP_SWEEP_MS + STAMP_HOLD_MS;
      const kept = at < recedeAt ? 1 : 1 - Math.ceil(((at - recedeAt) / STAMP_RECEDE_MS) * STAMP_STEPS) / STAMP_STEPS;
      const density = (x: number, y: number) => {
        const t = (x * w + y * dy) / diag;
        const band = Math.max(0, 1 - Math.abs(t - centre) / BAND);
        let d = k < 1 ? smooth(band) : 0;
        // Behind the band, the ink stays foil.
        if ((t < centre || k >= 1) && ink(x, y)) d = Math.max(d, kept);
        return d;
      };
      const inside = (x: number, y: number) => density(x, y) > bayerThreshold(Math.floor(x / grain), Math.floor(y / grain));
      px.fill(0);
      const seconds = now / 1000;
      foilCells(w, h, seconds, seed, since, inside, grain, (v, x, y) => {
        px[(y / grain) * cols + x / grain] = inkOf(v, deep);
      });
      foilGlitter(w, h, seconds, seed, inside, GLITTER, grain, (x, y, rw, rh) => {
        for (let cy = Math.floor(y / grain); cy < Math.ceil((y + rh) / grain); cy += 1) {
          for (let cx = Math.floor(x / grain); cx < Math.ceil((x + rw) / grain); cx += 1) {
            if (cx >= 0 && cy >= 0 && cx < cols && cy < rows) px[cy * cols + cx] = WHITE;
          }
        }
      });
      ctx.putImageData(image, 0, 0);
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return finish;
}

export default function FoilStamp({
  play,
  avatar = null,
  seed = 0.37,
  onDone,
}: {
  // Each new positive value plays one stamp (0 plays none).
  play: number;
} & StampOptions) {
  const frameRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Read at the play, never a reason to replay: the drawing may change under a stamp.
  const latest = useRef({ avatar, seed, onDone });
  latest.current = { avatar, seed, onDone };

  useEffect(() => {
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    if (play <= 0 || !frame || !canvas) return undefined;
    const { avatar: mark, seed: s, onDone: done } = latest.current;
    const w = frame.clientWidth;
    const h = frame.clientHeight;
    if (prefersReducedMotion() || w <= 0 || h <= 0) {
      done?.();
      return undefined;
    }
    const { cells, deep } = markOf(mark);
    return paintStamp(canvas, w, h, cells, deep, s ?? 0.37, () => done?.());
  }, [play]);

  return (
    <span ref={frameRef} className="foil-stamp" aria-hidden="true">
      <canvas ref={canvasRef} width={0} height={0} />
    </span>
  );
}
