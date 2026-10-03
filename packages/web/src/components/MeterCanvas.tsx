import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { prefersReducedMotion } from '../hooks/useScramble';
import { BAYER_8 } from '@whippin/shared';
import { paintFoil, type FoilScratch } from './foil';

// THE CHARGE METER'S DRAWING (#301, user-decided 2026-09-15: "improve the dithering, make it
// more smooth, and instead of just increasing the progression width with a basic animation,
// the dithering could be filled more and more"): the chip's conversion to the solve ink as
// an ORDERED DITHER. Every 2px cell of the chip has a threshold from the Bayer 8×8 matrix
// (64 levels — the smoothness), the fill's DENSITY ramps from solid to nothing over about
// one chip height ahead of the front, and a cell is inked when its threshold is under the
// density at its column. Advancing the front therefore does not slide an edge: cells light
// up one by one in threshold order across the ramp, the pixel art's own way of filling.
//
// AND THE HOLO (user-decided 2026-09-22, the activated hole — "something more holographic
// like a pokemon card… make something really beautiful this time"): once the meter is full
// and the hole ACTIVE, the chip is HOLOGRAPHIC FOIL — the app's shared material (`foil.ts`:
// spectrum, shimmer, sheen, sparkles), stepped at the strike sheets' own rate. Reduced motion
// holds one frame. ONE clock (`performance.now()`) on every surface that draws it, and EVERY
// HOLE ITS OWN FOIL (`seed`, user-decided 2026-09-22: "each hole should have a different
// seed"). The iridescent GLOW that goes with it on the sentence's chip is CSS
// (`.hole-meter.sea`, `sea-glow`).
//
// A canvas, because CSS cannot threshold a gradient through a pattern. It fills the meter's
// box (the chip's, `.hole-meter`), follows the box's size — the word's width changes as it
// scrambles — and redraws on each frame of the tween. TIMING is the meter's own contract:
// a change to `value` waits `delayMs` (the blood's landing) and travels `durationMs`
// (Hole's `METER_MS`), eased out; under reduced motion, or with no change, it draws the
// value at once. Nothing is laid out and nothing here is state: the value it shows is
// derived like the meter's reading, this only paces its arrival.
const CELL_PX = 2;

// THE FOIL is the shared material (`foil.ts`): this canvas only says where and when.

// Pixel art has nothing to gain from 60fps: the sheets' 50ms, a touch slower.
const SEA_FRAME_MS = 80;
// A meter filled on screen RECEDES into the foil rather than cutting to it: the solid ink
// thins to the foil over this long. A surface mounted already active starts on the foil
// (the burst, and the recede, are for the moment it happens, not for history).
const SEA_RECEDE_MS = 700;

export default function MeterCanvas({
  value,
  delayMs,
  durationMs,
  sea = false,
  seed = 0,
  onFull,
}: {
  value: number; // the meter's reading, 0-100
  delayMs: number; // how long a change waits before it travels
  durationMs: number; // how long it travels
  // The hole is ACTIVE: draw the sea instead of the ramp (the reading is then 100).
  sea?: boolean;
  // Which sea: every hole, and every given word, reads the field at its own place.
  seed?: number;
  // Told on the frame the fill inks the chip SOLID — its last — so what follows a full
  // meter (the hole's burst) waits for the fill itself, never for a guess at its length.
  onFull?: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const onFullRef = useRef(onFull);
  onFullRef.current = onFull;
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

  // The FOIL's painting (`foil.ts`), under what is left of the solid ink while it recedes.
  const scratch = useRef<FoilScratch>({});
  const foil = useCallback(
    (seconds: number, solid: number) => {
      const p = prepare();
      if (!p) return;
      const { canvas, ctx, w, h } = p;
      paintFoil(ctx, w, h, seconds, seed, scratch.current);
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
  // cells BEHIND the front, and the front — where the ink ends and the white begins — is
  // exactly the reading's share of the width, so a chip short of 100 always shows white at
  // its end (user-reported 2026-09-22: a front that ran past the edge by the ramp's length
  // inked the last column ~80% at 95, and "some users think that there's a bug" when the
  // full-looking chip gives nothing). Only 100 inks it solid, in one step: the fill's own
  // last frame, the burst on its heels.
  const drawRamp = useCallback(
    (p: number) => {
      const box = ref.current?.parentElement;
      if (!box) return;
      const cols = Math.ceil(box.clientWidth / CELL_PX);
      const ramp = Math.max(4, Math.round(box.clientHeight / CELL_PX));
      if (p >= 100) {
        paint(() => 1);
        return;
      }
      const front = (p / 100) * cols;
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
      if (to >= 100) onFullRef.current?.();
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
        else if (to >= 100) onFullRef.current?.();
      };
      pending.current.raf = requestAnimationFrame(step);
    }, delayMs);
    return cancel;
    // The delay and the travel are read when the value changes, like the CSS transition
    // they replace; a later change to either does not restart a tween.
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
    const reducedMotion = prefersReducedMotion();
    // A held frame must show the finished foil, without the recede's solid overlay.
    seaSince.current = drewRamp.current && !reducedMotion ? performance.now() : null;
    shown.current = 100;
    drawSea(performance.now());
    if (reducedMotion) return undefined;
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
