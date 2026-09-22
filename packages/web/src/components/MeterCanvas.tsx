import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { prefersReducedMotion } from '../hooks/useScramble';
import { T0, hash3, noise3 } from './noise';

// THE CHARGE METER'S DRAWING (#301, user-decided 2026-09-15: "improve the dithering, make it
// more smooth, and instead of just increasing the progression width with a basic animation,
// the dithering could be filled more and more"): the chip's conversion to the solve ink as
// an ORDERED DITHER. Every 2px cell of the chip has a threshold from the Bayer 8×8 matrix
// (64 levels — the smoothness), the fill's DENSITY ramps from solid to nothing over about
// one chip height ahead of the front, and a cell is inked when its threshold is under the
// density at its column. Advancing the front therefore does not slide an edge: cells light
// up one by one in threshold order across the ramp, the pixel art's own way of filling.
//
// AND THE HOLO (user-decided 2026-09-22, the activated hole — "a new kind of hole
// design… something between the full blue hole and the empty white one", then, after a
// dithered sea in both colour orders and a smooth cobalt wash, "something more holographic
// like a pokemon card… make something really beautiful this time"): once the meter is
// full and the hole ACTIVE, the chip is HOLOGRAPHIC FOIL — the white chip catching light
// it is not under. Four layers, every frame, all under the dark ink:
//   1. THE SPECTRUM: a pastel rainbow band (HSL hues at high lightness, so the ink stays
//      legible on it) running diagonally through the word and drifting along it — the
//      angle-dependent rainbow of a foil, with time standing in for the tilt;
//   2. THE SHIMMER: the spectrum is MASKED by one octave of value noise (`noise.ts`)
//      scrolled through the word, so the rainbow does not slide flat but pools and swirls,
//      a "cosmos" foil rather than a printed gradient; a bitmap one pixel a cell, drawn up
//      through bilinear smoothing;
//   3. THE SHEEN: one soft white specular band sweeping the diagonal on its own, slower
//      period — the flash a card gives as it turns;
//   4. THE SPARKLES: a few pixel-art four-point stars (a plus of 2px cells) blinking in
//      and out at hashed cells — the glitter in the foil.
// STEPPED at the strike sheets' own rate, not 60fps: a foil turning in a hand, not a
// shader. Reduced motion holds one frame. ONE clock (`performance.now()`) on every surface
// that draws it, and EVERY HOLE ITS OWN FOIL (`seed`, user-decided 2026-09-22: "each hole
// should have a different seed") — the same material, not the same picture, from one chip
// to the next and from one given word to the next. The iridescent GLOW that goes with it
// on the sentence's chip is CSS (`.hole-meter.sea`, `sea-glow`).
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

// THE FOIL'S SHAPE.
// The spectrum: HOLO_CYCLES full rainbows across the chip's diagonal, drifting HOLO_DRIFT
// of a chip a second, at HOLO_LIGHT lightness (pastel: the ink has to read on every hue)
// and HOLO_ALPHA over the white at its strongest.
const HOLO_CYCLES = 1.25;
const HOLO_DRIFT = 0.09;
const HOLO_LIGHT = 74;
const HOLO_ALPHA = 0.72;
// The shimmer: a lattice unit is SHIMMER_CELLS cells (a chip is ~15 cells tall at the
// sentence's size), sliding SHIMMER_DRIFT units a second and evolving SHIMMER_EVOLVE a
// second in the third dimension — never a loop; the mask spans SHIMMER_FLOOR to 1 of the
// spectrum's alpha, so the rainbow is never absent, only pooled.
const SHIMMER_CELLS_X = 11;
const SHIMMER_CELLS_Y = 6;
const SHIMMER_DRIFT = 0.35;
const SHIMMER_EVOLVE = 0.2;
const SHIMMER_FLOOR = 0.3;
// The sheen: a white band SHEEN_WIDTH of the diagonal wide at SHEEN_ALPHA, once every
// SHEEN_PERIOD_S along it.
const SHEEN_WIDTH = 0.28;
const SHEEN_ALPHA = 0.5;
const SHEEN_PERIOD_S = 4.5;
// The sparkles: a cell is a star SPARKLE_SHARE of the time, each blink SPARKLE_BLINK_S
// long, brightest in its middle.
const SPARKLE_SHARE = 0.006;
const SPARKLE_BLINK_S = 0.7;
// Pixel art has nothing to gain from 60fps: the sheets' 50ms, a touch slower.
const SEA_FRAME_MS = 80;
// A meter filled on screen RECEDES into the foil rather than cutting to it: the solid ink
// thins to the foil over this long. A surface mounted already active starts on the foil
// (the burst, and the recede, are for the moment it happens, not for history).
const SEA_RECEDE_MS = 700;

// The shimmer at a cell, 0–1: the noise, read at this seed's own place in the field.
function shimmerAt(cx: number, cy: number, seconds: number, seed: number): number {
  const n = noise3(
    cx / SHIMMER_CELLS_X - seconds * SHIMMER_DRIFT + seed * 101.7,
    cy / SHIMMER_CELLS_Y + seed * 53.1,
    T0 + seconds * SHIMMER_EVOLVE,
  );
  // One octave of value noise lives mostly in 0.3–0.7: stretched about the half so the
  // pools reach full and the troughs the floor.
  const v = Math.min(1, Math.max(0, 0.5 + (n - 0.5) * 2.4));
  return SHIMMER_FLOOR + (1 - SHIMMER_FLOOR) * v;
}

// The fractional part: where along the diagonal (0 at the top-left, 1 at the
// bottom-right) a band's position `k` (any real) falls, wrapped.
const wrap = (k: number) => k - Math.floor(k);

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

  // The FOIL's painting: the four layers, in order, on the chip's white.
  const bitmap = useRef<HTMLCanvasElement | null>(null);
  const foil = useCallback(
    (seconds: number, solid: number) => {
      const p = prepare();
      if (!p) return;
      const { canvas, ctx, w, h, cols, rows } = p;
      // The diagonal the band and the sheen run along: top-left to bottom-right, leaning
      // with the chip's width so a long word still shows the whole spectrum.
      const dx = w;
      const dy = h * 0.9;

      // 1. THE SPECTRUM, drifting along the diagonal.
      const spectrum = ctx.createLinearGradient(0, 0, dx, dy);
      const shift = wrap(seconds * HOLO_DRIFT + seed * 0.37);
      const stops = 12;
      for (let i = 0; i <= stops; i += 1) {
        const at = i / stops;
        const hue = Math.round(wrap((at - shift) * HOLO_CYCLES) * 360);
        spectrum.addColorStop(at, `hsl(${hue} 100% ${HOLO_LIGHT}%)`);
      }
      ctx.fillStyle = spectrum;
      ctx.fillRect(0, 0, w, h);

      // 2. THE SHIMMER: keep the spectrum where the field pools, thin it where it troughs
      // — the mask is a bitmap one pixel a cell drawn up through bilinear smoothing.
      const off = (bitmap.current ??= document.createElement('canvas'));
      if (off.width !== cols || off.height !== rows) {
        off.width = cols;
        off.height = rows;
      }
      const octx = off.getContext('2d');
      if (!octx) return;
      const img = octx.createImageData(cols, rows);
      const d = img.data;
      for (let cy = 0; cy < rows; cy += 1) {
        for (let cx = 0; cx < cols; cx += 1) {
          const i = (cy * cols + cx) * 4;
          d[i + 3] = Math.round(255 * HOLO_ALPHA * shimmerAt(cx, cy, seconds, seed));
        }
      }
      octx.putImageData(img, 0, 0);
      ctx.globalCompositeOperation = 'destination-in';
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(off, 0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';

      // 3. THE SHEEN: a soft white band passing along the diagonal.
      const pass = wrap(seconds / SHEEN_PERIOD_S + seed * 0.61);
      const centre = -SHEEN_WIDTH + pass * (1 + 2 * SHEEN_WIDTH);
      const sheen = ctx.createLinearGradient(0, 0, dx, dy);
      const edge = (k: number) => Math.min(1, Math.max(0, k));
      sheen.addColorStop(edge(centre - SHEEN_WIDTH), 'rgba(255,255,255,0)');
      sheen.addColorStop(edge(centre), `rgba(255,255,255,${SHEEN_ALPHA})`);
      sheen.addColorStop(edge(centre + SHEEN_WIDTH), 'rgba(255,255,255,0)');
      ctx.fillStyle = sheen;
      ctx.fillRect(0, 0, w, h);

      // 4. THE SPARKLES: four-point stars at hashed cells, each blinking once.
      const blink = Math.floor(seconds / SPARKLE_BLINK_S);
      const phase = seconds / SPARKLE_BLINK_S - blink;
      const twinkle = Math.sin(phase * Math.PI); // 0 → 1 → 0 across the blink
      ctx.fillStyle = `rgba(255,255,255,${0.95 * twinkle})`;
      for (let cy = 1; cy < rows - 1; cy += 1) {
        for (let cx = 1; cx < cols - 1; cx += 1) {
          if (hash3(cx + seed * 977, cy, blink) >= SPARKLE_SHARE) continue;
          const x = cx * CELL_PX;
          const y = cy * CELL_PX;
          ctx.fillRect(x - CELL_PX, y, 3 * CELL_PX, CELL_PX);
          ctx.fillRect(x, y - CELL_PX, CELL_PX, 3 * CELL_PX);
        }
      }

      // THE RECEDE: what is left of the solid ink the fill reached.
      if (solid > 0) {
        ctx.globalAlpha = solid;
        ctx.fillStyle = getComputedStyle(canvas).color;
        ctx.fillRect(0, 0, w, h);
        ctx.globalAlpha = 1;
      }
    },
    [prepare, seed],
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

  // The foil at this instant, under what is left of the solid chip while the recede runs.
  const drawSea = useCallback(
    (now: number) => {
      const since = seaSince.current;
      const solid = since === null ? 0 : Math.max(0, 1 - (now - since) / SEA_RECEDE_MS);
      foil(now / 1000, solid);
    },
    [foil],
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
