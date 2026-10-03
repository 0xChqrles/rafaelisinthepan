import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { HEAT_CELL_PX, heatCells } from '@whippin/shared';
import { prefersReducedMotion } from '../hooks/useScramble';

// THE RUN'S HEAT on the screen, rising off the result's ruler (`SolvedCard`): the field itself
// — the run's inks dithered on whole cells, each column as tall as that try's reconstruction
// got, its ragged top, its grain — is shared (`@whippin/shared` `runHeat.ts`), ONE spelling for
// the screen and the share card, which draws the same field still. This paints it on 2px cells
// and ANIMATES it.
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
// rising to 1 away from it — shared `heatKeepOut`), and the field thins to nothing round each
// thing through the same Bayer order, so a digit rises out of the heat with a dark margin,
// never stippled up to its edge or inside its counters. The multiplier is asked for on every
// frame; `keepOutKey` names what it depends on, and a change redraws the still frame round it.

// A column rising off the write head.
const RISE_STEPS = 3;
const RISE_STEP_MS = 45;
// The landing surge.
const SURGE_STEPS = 4;
const SURGE_MS = 480;

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
      const keep = keepOutRef.current?.(canvas) ?? null;
      let fill = '';
      heatCells(
        {
          cols: Math.floor(w / HEAT_CELL_PX),
          rows: Math.floor(h / HEAT_CELL_PX),
          width: w,
          cell: HEAT_CELL_PX,
          trajectory,
          shown,
          // A try written before the clock ran stands whole; one written since rises in steps.
          rise: (i) => {
            const at = born.current[i];
            if (at === undefined) return 1;
            const step = Math.floor((now - at) / RISE_STEP_MS) + 1;
            if (step >= RISE_STEPS) return 1;
            moving = true;
            return step / RISE_STEPS;
          },
          lift,
          clear: keep && ((cx, cy) => keep((cx + 0.5) * HEAT_CELL_PX, h - (cy + 0.5) * HEAT_CELL_PX)),
        },
        (color, cx, cy) => {
          if (color !== fill) ctx.fillStyle = fill = color;
          ctx.fillRect(cx * HEAT_CELL_PX, h - (cy + 1) * HEAT_CELL_PX, HEAT_CELL_PX, HEAT_CELL_PX);
        },
      );
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
