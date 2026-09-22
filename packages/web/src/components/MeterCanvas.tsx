import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { prefersReducedMotion } from '../hooks/useScramble';
import { T0, noise3 } from './noise';

// THE CHARGE METER'S DRAWING (#301, user-decided 2026-09-15: "improve the dithering, make it
// more smooth, and instead of just increasing the progression width with a basic animation,
// the dithering could be filled more and more"): the chip's conversion to the solve ink as
// an ORDERED DITHER. Every 2px cell of the chip has a threshold from the Bayer 8×8 matrix
// (64 levels — the smoothness), the fill's DENSITY ramps from solid to nothing over about
// one chip height ahead of the front, and a cell is inked when its threshold is under the
// density at its column. Advancing the front therefore does not slide an edge: cells light
// up one by one in threshold order across the ramp, the pixel art's own way of filling.
//
// AND THE SEA (user-decided 2026-09-22, the activated hole: "a new kind of hole design…
// something between the full blue hole and the empty white one, with moving waves maybe,
// some perlin noise"): once the meter is full and the hole ACTIVE, the chip is a FIELD —
// one octave of value noise scrolled sideways through the word, cobalt swell drifting
// through the white ground under the dark ink. SMOOTH, NOT DITHERED (the user's third
// pass the same day: the dither, in both colour orders, was "still hard to read… let's
// try something smooth just to see"): the field is painted at cell resolution into an
// offscreen bitmap as the solve ink at the wave's own alpha and drawn up to the chip
// through bilinear smoothing — a wash, deliberately, the one the rebrand otherwise bans,
// because a hole that has activated has to "hit different". Biased to white (`SEA_BIAS`)
// so the ink sits on white more often than not, never bare cobalt (`SEA_FLOOR`). STEPPED
// at the strike sheets' own rate, not 60fps, and slow: this is a permanent animation on
// the sentence. Reduced motion holds one frame of it. The sea is ONE clock
// (`performance.now()`) on every surface that draws it, and EVERY HOLE ITS OWN FIELD
// (`seed`, user-decided 2026-09-22: "each hole should have a different seed") — the same
// material, not the same picture, from one chip to the next and from one given word to
// the next. The GLOW that goes with it on the sentence's chip is CSS (`.hole-meter.sea`).
//
// A canvas, because CSS cannot threshold a gradient through a pattern. It fills the meter's
// box (the chip's, `.hole-meter`), follows the box's size — the word's width changes as it
// scrambles — and redraws on each frame of the tween. TIMING is the meter's own contract:
// a change to `value` waits `delayMs` (the blood's landing) and travels `durationMs`
// (Hole's `METER_MS`), eased out; under reduced motion, or with no change, it draws the
// value at once. Nothing is laid out and nothing here is state: the value it shows is
// derived like the meter's reading, this only paces its arrival.
const CELL_PX = 2;
// prettier-ignore
const BAYER_8: readonly number[] = [
   0, 32,  8, 40,  2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44,  4, 36, 14, 46,  6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
   3, 35, 11, 43,  1, 33,  9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47,  7, 39, 13, 45,  5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];

// THE SEA'S SHAPE. A lattice unit is SEA_CELLS_X cells wide (24px) and SEA_CELLS_Y tall
// (a chip is ~15 cells at the sentence's size, so about two features stand in its height);
// the field slides SEA_DRIFT units a second along the word and evolves SEA_EVOLVE units a
// second in its third dimension — a swell that travels and changes, never a loop; the
// noise's own contrast is stretched by SEA_CONTRAST about SEA_BIAS so the dither spans
// solid white to a faint SEA_FLOOR of it — never bare cobalt: a trough must still read as
// the sea, not as a meter frozen full — and the ink sits on white more often than not
// (SEA_BIAS above the half: the readability the reversal was asked for).
const SEA_CELLS_X = 12;
const SEA_CELLS_Y = 7;
const SEA_DRIFT = 0.5;
const SEA_EVOLVE = 0.22;
const SEA_CONTRAST = 2.6;
const SEA_BIAS = 0.64;
const SEA_FLOOR = 0.12;
// Pixel art has nothing to gain from 60fps: the sheets' 50ms, a touch slower.
const SEA_FRAME_MS = 80;
// A meter filled on screen RECEDES into the sea rather than cutting to it: the white
// rises through the solid ink to the field over this long. A surface mounted already active starts on the
// field (the burst, and the recede, are for the moment it happens, not for history).
const SEA_RECEDE_MS = 700;

// The WHITE at a cell, 0–1: the noise, read at this seed's own place in the field.
function seaDensity(cx: number, cy: number, seconds: number, seed: number): number {
  const n = noise3(
    cx / SEA_CELLS_X - seconds * SEA_DRIFT + seed * 101.7,
    cy / SEA_CELLS_Y + seed * 53.1,
    T0 + seconds * SEA_EVOLVE,
  );
  return SEA_FLOOR + (1 - SEA_FLOOR) * Math.min(1, Math.max(0, SEA_BIAS + (n - 0.5) * SEA_CONTRAST));
}

export default function MeterCanvas({
  value,
  delayMs,
  durationMs,
  sea = false,
  seed = 0,
}: {
  value: number; // the meter's reading, 0-100
  delayMs: number; // how long a change waits before it travels
  durationMs: number; // how long it travels
  // The hole is ACTIVE: draw the sea instead of the ramp (the reading is then 100).
  sea?: boolean;
  // Which sea: every hole, and every given word, reads the field at its own place.
  seed?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const shown = useRef(value); // what is on the canvas right now
  const pending = useRef<{ timer: number; raf: number }>({ timer: 0, raf: 0 });
  // When the sea began on this canvas, for the recede; null on a canvas born in the sea
  // (`drewRamp` says whether it ever showed the ramp).
  const seaSince = useRef<number | null>(null);
  const drewRamp = useRef(false);
  const seaLoop = useRef<{ timer: number; raf: number }>({ timer: 0, raf: 0 });

  // The canvas, sized to its box at the device's resolution, with a 2d context ready to
  // draw in CSS pixels; null while the box has no size.
  const prepare = useCallback(() => {
    const canvas = ref.current;
    const box = canvas?.parentElement;
    if (!canvas || !box) return null;
    const w = box.clientWidth;
    const h = box.clientHeight;
    if (!w || !h) return null;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { canvas, ctx, w, h, cols: Math.ceil(w / CELL_PX), rows: Math.ceil(h / CELL_PX) };
  }, []);

  // The RAMP's painting: every cell whose Bayer threshold is under the density at its
  // place is inked in the meter's colour.
  const paint = useCallback(
    (density: (cx: number, cy: number) => number) => {
      const p = prepare();
      if (!p) return;
      const { canvas, ctx, cols, rows } = p;
      ctx.fillStyle = getComputedStyle(canvas).color;
      for (let cx = 0; cx < cols; cx += 1) {
        for (let cy = 0; cy < rows; cy += 1) {
          const d = density(cx, cy);
          if (d <= 0) continue;
          if (BAYER_8[(cy & 7) * 8 + (cx & 7)] < d * 64) ctx.fillRect(cx * CELL_PX, cy * CELL_PX, CELL_PX, CELL_PX);
        }
      }
    },
    [prepare],
  );

  // The SEA's painting: the solve ink at each cell's own alpha, on a bitmap one pixel a
  // cell, drawn up to the chip through the browser's bilinear smoothing.
  const bitmap = useRef<HTMLCanvasElement | null>(null);
  const wash = useCallback(
    (alpha: (cx: number, cy: number) => number) => {
      const p = prepare();
      if (!p) return;
      const { canvas, ctx, w, h, cols, rows } = p;
      const off = (bitmap.current ??= document.createElement('canvas'));
      if (off.width !== cols || off.height !== rows) {
        off.width = cols;
        off.height = rows;
      }
      const octx = off.getContext('2d');
      if (!octx) return;
      const [r, g, b] = (getComputedStyle(canvas).color.match(/\d+/g) ?? ['74', '106', '255']).map(Number);
      const img = octx.createImageData(cols, rows);
      const d = img.data;
      for (let cy = 0; cy < rows; cy += 1) {
        for (let cx = 0; cx < cols; cx += 1) {
          const i = (cy * cols + cx) * 4;
          d[i] = r;
          d[i + 1] = g;
          d[i + 2] = b;
          d[i + 3] = Math.round(255 * Math.min(1, Math.max(0, alpha(cx, cy))));
        }
      }
      octx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(off, 0, 0, w, h);
    },
    [prepare],
  );

  // The ramp: the fill's density falls from solid to nothing over about a chip's height of
  // cells ahead of the front; the front runs past the right edge by the ramp's length so
  // that 100% inks the last column solid.
  const drawRamp = useCallback(
    (p: number) => {
      const box = ref.current?.parentElement;
      if (!box) return;
      const cols = Math.ceil(box.clientWidth / CELL_PX);
      const ramp = Math.max(4, Math.round(box.clientHeight / CELL_PX));
      const front = (p / 100) * (cols + ramp);
      paint((cx) => Math.min(1, (front - cx) / ramp));
    },
    [paint],
  );

  // The sea at this instant: the ink's alpha is what the wave leaves of the white, held
  // toward the solid chip while the recede runs.
  const drawSea = useCallback(
    (now: number) => {
      const seconds = now / 1000;
      const since = seaSince.current;
      const risen = since === null ? 1 : Math.min(1, (now - since) / SEA_RECEDE_MS);
      wash((cx, cy) => 1 - risen * seaDensity(cx, cy, seconds, seed));
    },
    [wash, seed],
  );

  // What the canvas shows right now, whichever reading it is on.
  const draw = useCallback(() => {
    if (sea) drawSea(performance.now());
    else drawRamp(shown.current);
  }, [sea, drawRamp, drawSea]);

  // The box's size is the word's, which the scramble changes: follow it.
  useLayoutEffect(() => {
    const box = ref.current?.parentElement;
    if (!box) return undefined;
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(box);
    return () => ro.disconnect();
  }, [draw]);

  useEffect(() => {
    if (sea) return undefined;
    drewRamp.current = true;
    const cancel = () => {
      window.clearTimeout(pending.current.timer);
      cancelAnimationFrame(pending.current.raf);
    };
    cancel();
    const from = shown.current;
    const to = value;
    if (from === to) return undefined;
    if (prefersReducedMotion() || durationMs <= 0) {
      shown.current = to;
      drawRamp(to);
      return undefined;
    }
    pending.current.timer = window.setTimeout(() => {
      const t0 = performance.now();
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / durationMs);
        const eased = 1 - (1 - k) ** 3;
        shown.current = from + (to - from) * eased;
        drawRamp(shown.current);
        if (k < 1) pending.current.raf = requestAnimationFrame(step);
      };
      pending.current.raf = requestAnimationFrame(step);
    }, delayMs);
    return cancel;
    // The delay and the travel are read when the value changes, like the CSS transition
    // they replace; a later change to either does not restart a tween.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, drawRamp, sea]);

  // THE SEA'S CLOCK: a frame every SEA_FRAME_MS while the sea is up — stepped, so it reads
  // as an animation and not a shader. A canvas that was drawing the ramp when the sea came
  // recedes into it from the solid it had reached; one born in the sea starts on the field.
  // Reduced motion draws ONE frame and stops.
  useEffect(() => {
    if (!sea) {
      seaSince.current = null;
      return undefined;
    }
    window.clearTimeout(pending.current.timer);
    cancelAnimationFrame(pending.current.raf);
    seaSince.current = drewRamp.current ? performance.now() : null;
    shown.current = 100;
    drawSea(performance.now());
    if (prefersReducedMotion()) return undefined;
    const loop = seaLoop.current;
    const tick = () => {
      loop.timer = window.setTimeout(() => {
        loop.raf = requestAnimationFrame((now) => {
          drawSea(now);
          tick();
        });
      }, SEA_FRAME_MS);
    };
    tick();
    return () => {
      window.clearTimeout(loop.timer);
      cancelAnimationFrame(loop.raf);
    };
  }, [sea, drawSea]);

  return <canvas ref={ref} className="hole-meter-canvas" aria-hidden="true" />;
}
