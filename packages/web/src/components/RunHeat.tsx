import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { BAYER_8, progressHeatColor } from '@whippin/shared';
import { T0, noise3 } from './noise';
import { prefersReducedMotion } from '../hooks/useScramble';

// THE RUN'S HEAT, rising off the result's ruler (`SolvedCard`, screen-only decoration — the
// share card draws no heat): the run drawn a second time, as the cards draw a distance — in the heat's own inks, ORDERED-DITHERED on whole cells (shared `bayer.ts`,
// the app's one way of turning a density into pixels). Every column stands over the ruler
// cell under it, in that try's ink, and rises as high as that try's reconstruction got:
// a run's climb reads as a skyline climbing toward its cobalt end, densest on the bar and
// thinning to nothing above it. An unfinished run never reaches the full height nor the
// cobalt. A static grain of the app's one value noise (`noise.ts`) breaks the rows, so it
// reads as heat and not as a bar chart.
//
// It is the ruler's own reading, so it follows the TALLY (`filled`, the count itself): a
// try's column rises as its cell is written, in RISE_STEPS hard steps — the heat coming
// off the write head — and on the LANDING the whole field surges (denser and taller) and
// settles back in SURGE_STEPS steps: the hit of the count stopping. At rest it is ONE
// still frame (no clock runs), and a settled or reduced-motion result draws that frame
// outright.
//
// THE CLEARING (`keepOut`): what stands IN the heat — the count, its unit — stands in a
// clearing of bare ground: the card hands a density multiplier (0 at what it keeps clear,
// rising to 1 away from it), and the field thins to nothing round each thing through the
// same Bayer order, so a digit rises out of the heat with a dark margin, never stippled
// up to its edge or inside its counters. The multiplier is asked for on every frame;
// `keepOutKey` names what it depends on, and a change redraws the still frame round it.
const CELL_PX = 2;
// A column's height: HEAT_FLOOR of the field at 0%, the whole field at 100%, at rest
// HEAT_REST of the canvas (the surge rises into the rest).
const HEAT_FLOOR = 0.16;
const HEAT_REST = 0.78;
// The density on the bar, falling to nothing at the column's top along a power curve.
const HEAT_BASE = 0.62;
const HEAT_GAMMA = 1.7;
// The grain: one octave of value noise, a lattice unit of GRAIN_X × GRAIN_Y cells, scaling
// the density between GRAIN_FLOOR and GRAIN_FLOOR + GRAIN_SPAN.
const GRAIN_X = 3;
const GRAIN_Y = 5;
const GRAIN_FLOOR = 0.55;
const GRAIN_SPAN = 0.9;
// The field's TOP is ragged, never a ruled line: each column's height is scaled by the same
// noise read along the bar (a lattice unit of EDGE_X cells), between 1 − EDGE_JAG and
// 1 + EDGE_JAG — so a plateau of equal tries (or a one-try run's single column) still
// rises as heat, not as a block.
const EDGE_X = 5;
const EDGE_JAG = 0.22;
// A column rising off the write head.
const RISE_STEPS = 3;
const RISE_STEP_MS = 45;
// The landing surge.
const SURGE_STEPS = 4;
const SURGE_MS = 480;
const SURGE_GAIN = 0.9;

export type HeatKeepOut = (
  canvas: HTMLCanvasElement,
) => ((x: number, y: number) => number) | null;

export default function RunHeat({
  trajectory,
  filled,
  surge,
  still,
  keepOut,
  keepOutKey,
}: {
  trajectory: number[];
  filled: number; // how many tries are written (the tally's count)
  surge: boolean; // the count has landed: play the surge once
  still: boolean; // the settled frame: draw the finished field, no motion
  // The clearing, asked for on each frame: a multiplier at a point of the canvas (CSS px).
  keepOut?: HeatKeepOut;
  keepOutKey?: string; // a change redraws (what stands in the heat changed)
}) {
  const keepOutRef = useRef(keepOut);
  keepOutRef.current = keepOut;
  const ref = useRef<HTMLCanvasElement>(null);
  // When each try's column began to rise; a try written before the clock ran stands whole.
  const born = useRef<number[]>([]);
  const surgeAt = useRef<number | null>(null);
  const raf = useRef(0);
  const filledRef = useRef(filled);
  filledRef.current = filled;

  const draw = useCallback(
    (now: number) => {
      const canvas = ref.current;
      if (!canvas) return false;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return false;
      const dpr = window.devicePixelRatio || 1;
      const bw = Math.round(w * dpr);
      const bh = Math.round(h * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return false;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const n = trajectory.length;
      if (n === 0) return false;
      const cols = Math.floor(w / CELL_PX);
      const rows = Math.floor(h / CELL_PX);
      const shown = Math.min(filledRef.current, n);
      let moving = false;

      // The surge's step: 1 on the landing, falling to 0 in whole steps.
      let lift = 0;
      if (surgeAt.current !== null) {
        const t = now - surgeAt.current;
        if (t < SURGE_MS) {
          lift = 1 - Math.floor((t / SURGE_MS) * SURGE_STEPS) / SURGE_STEPS;
          moving = true;
        }
      }
      const clear = keepOutRef.current?.(canvas) ?? null;
      const restRows = rows * HEAT_REST;
      const peakRows = restRows + (rows - restRows) * lift;
      const gain = 1 + SURGE_GAIN * lift;

      for (let cx = 0; cx < cols; cx += 1) {
        // The try under this column's centre.
        const i = Math.min(n - 1, Math.floor((((cx + 0.5) * CELL_PX) / w) * n));
        if (i >= shown) continue;
        let rise = 1;
        const at = born.current[i];
        if (at !== undefined) {
          const step = Math.floor((now - at) / RISE_STEP_MS) + 1;
          if (step < RISE_STEPS) {
            rise = step / RISE_STEPS;
            moving = true;
          }
        }
        const pct = trajectory[i];
        const jag = 1 + EDGE_JAG * (2.4 * (noise3(cx / EDGE_X, 0.5, T0 + 7.3) - 0.5));
        const tall = Math.min(
          rows,
          peakRows * (HEAT_FLOOR + (1 - HEAT_FLOOR) * (pct / 100)) * rise * jag,
        );
        if (tall <= 0) continue;
        ctx.fillStyle = progressHeatColor(pct);
        for (let cy = 0; cy < tall && cy < rows; cy += 1) {
          const fall = (1 - cy / tall) ** HEAT_GAMMA;
          const grain = GRAIN_FLOOR + GRAIN_SPAN * noise3(cx / GRAIN_X, cy / GRAIN_Y, T0);
          let d = Math.min(1, HEAT_BASE * fall * grain * gain);
          if (clear) d *= clear((cx + 0.5) * CELL_PX, h - (cy + 0.5) * CELL_PX);
          if (BAYER_8[((cy & 7) << 3) | (cx & 7)] < d * 64) {
            ctx.fillRect(cx * CELL_PX, h - (cy + 1) * CELL_PX, CELL_PX, CELL_PX);
          }
        }
      }
      return moving;
    },
    [trajectory],
  );

  // A frame while anything moves; none at rest.
  const run = useCallback(() => {
    cancelAnimationFrame(raf.current);
    const frame = (now: number) => {
      if (draw(now)) raf.current = requestAnimationFrame(frame);
    };
    raf.current = requestAnimationFrame(frame);
  }, [draw]);

  // The tally writes tries: each newly written one starts rising now.
  const last = useRef(still ? trajectory.length : 0);
  useEffect(() => {
    if (still || prefersReducedMotion()) {
      born.current = [];
      surgeAt.current = null;
      last.current = filled;
      cancelAnimationFrame(raf.current);
      draw(performance.now());
      return;
    }
    const now = performance.now();
    for (let i = last.current; i < filled; i += 1) born.current[i] = now;
    last.current = filled;
    run();
  }, [filled, still, draw, run]);

  useEffect(() => {
    if (!surge || still || prefersReducedMotion()) return;
    surgeAt.current = performance.now();
    run();
  }, [surge, still, run]);

  // The box is the ruler's width: follow it.
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const redraw = () => draw(performance.now());
    redraw();
    const ro = new ResizeObserver(redraw);
    ro.observe(canvas);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf.current);
    };
  }, [draw]);

  // What stands in the heat changed (the tally wrote a digit, the layout settled): the
  // still frame is redrawn round it.
  useLayoutEffect(() => {
    if (keepOutKey === undefined) return;
    draw(performance.now());
  }, [keepOutKey, draw]);

  return <canvas ref={ref} className="solved-card-heat" aria-hidden="true" />;
}
