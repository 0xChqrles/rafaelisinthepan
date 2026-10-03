import { useEffect, useRef } from 'react';
import { COUNT_STILL_S } from '@whippin/shared';
import crownSvg from '../assets/icons/board.svg?raw';
import { paintFoil } from './foil';
import { cellInked } from './meterRamp';
import { prefersReducedMotion } from '../hooks/useScramble';

// THE BOARD'S ONE SHINY THING: first place's CROWN in the holographic FOIL. A board is about
// who leads, so the crown is its subject the way the count is the result's — and like the
// count it is the house's one shiny MATERIAL (`foil.ts`, shared: the dithered spectrum, the
// shimmer, the sheen passing, the glitter), never a glow. It wears NO GLINTS: the count's
// star on a 30px mark is a white cross standing on the crown most of the time, not a spark —
// the sheen's pass and the glitter's rare flecks are the shine, each an event.
//
// The crown is the header's own board mark (`board.svg`, read cell for cell, so the two can
// never drift), at 3px a cell — a size up from the result's 20px, the board's subject — and
// the foil is laid on the CROWN'S grain (as the share card lays it on its own larger cell),
// CLIPPED to its cells, so every foil cell, every dither step of the recede and every fleck of
// glitter is one of the crown's own pixels and its silhouette never changes. It lands COBALT, the trophy blue every other crown wears, and on the
// leader's number landing (`litMs` after the mount) its cobalt DISSOLVES into the foil — the
// solid cells dropping out in the Bayer matrix's order in RECEDE_STEPS hard steps, the count's
// own recede. Under reduced motion it is born in the foil and holds one still instant.
//
// THE CLOCK RESTS. It steps every FRAME_MS (the foil's pace on every surface) only while the
// crown is on screen, the tab visible, and the page in use: IDLE_MS after the last touch,
// key, wheel or scroll it holds the frame it is on, and the next one wakes it — a board left
// open on a phone burns nothing.
const CELL = 3;
const GRID = 10;
const SIZE = GRID * CELL;
const FRAME_MS = 80;
const RECEDE_MS = 700;
const RECEDE_STEPS = 8;
const IDLE_MS = 9000;

// The crown's cells, off the icon's own rects.
const INK = (() => {
  const ink = new Array<boolean>(GRID * GRID).fill(false);
  for (const m of crownSvg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)) {
    const [x, y, w, h] = m.slice(1).map(Number);
    for (let gy = y; gy < y + h; gy += 1) for (let gx = x; gx < x + w; gx += 1) ink[gy * GRID + gx] = true;
  }
  return ink;
})();
const inked = (gx: number, gy: number) => gx >= 0 && gx < GRID && gy >= 0 && gy < GRID && INK[gy * GRID + gx];
const inside = (x: number, y: number) => inked(Math.floor(x / CELL), Math.floor(y / CELL));

export default function FoilCrown({ litMs, seed }: { litMs: number; seed: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return undefined;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(SIZE * dpr);
    canvas.height = Math.round(SIZE * dpr);
    const accent = getComputedStyle(canvas).getPropertyValue('--accent').trim() || '#4a6aff';
    const reduced = prefersReducedMotion();
    // THE CUE rides the page's own animation clock — an empty animation `litMs` long — so the
    // crown lights exactly as the leader's reels stop, whatever the page's playback rate (the
    // reels are Web Animations too). Until it fires, the crown is cobalt. Every time here is
    // read off that same clock — the document timeline, which the frames' own timestamps
    // follow — never `performance.now()`: a page played slower (DevTools' animation speed)
    // slows the timeline but not the wall clock, and a cue stamped on the wall clock would sit
    // in the frames' future forever.
    const clock = () => {
      const time = document.timeline.currentTime;
      return typeof time === 'number' ? time : performance.now();
    };
    let lit = Infinity;
    const cue = reduced ? null : canvas.animate([], { duration: Math.max(0, litMs) });
    cue?.finished.then(
      () => {
        lit = clock();
      },
      () => {},
    );
    // The crown's cells (those `keep` names) as the current path: filled for the cobalt, and
    // the clip every frame's foil is painted under (the glitter's arms would otherwise reach
    // past its edge).
    const trace = (keep: (gx: number, gy: number) => boolean) => {
      ctx.beginPath();
      for (let gy = 0; gy < GRID; gy += 1) {
        for (let gx = 0; gx < GRID; gx += 1) if (inked(gx, gy) && keep(gx, gy)) ctx.rect(gx * CELL, gy * CELL, CELL, CELL);
      }
    };
    const cells = (keep: (gx: number, gy: number) => boolean) => {
      trace(keep);
      ctx.fill();
    };
    const draw = (now: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.fillStyle = accent;
      if (!reduced && now < lit) {
        cells(() => true);
        return;
      }
      const seconds = reduced ? COUNT_STILL_S : now / 1000;
      ctx.save();
      trace(() => true);
      ctx.clip();
      paintFoil(ctx, SIZE, SIZE, seconds, seed, reduced ? null : lit / 1000, inside, undefined, CELL);
      ctx.restore();
      // The cobalt receding into it, in whole Bayer steps.
      const solid = reduced ? 0 : Math.max(0, 1 - (now - lit) / RECEDE_MS);
      if (solid > 0) {
        const level = Math.ceil(solid * RECEDE_STEPS) / RECEDE_STEPS;
        ctx.fillStyle = accent;
        cells((gx, gy) => cellInked(level, gx, gy));
      }
    };
    draw(clock());
    if (reduced) return undefined;

    let timer = 0;
    let raf = 0;
    let running = false;
    let inView = true;
    let awake = true;
    let idle = 0;
    const tick = () => {
      timer = window.setTimeout(() => {
        raf = requestAnimationFrame((now) => {
          draw(now);
          tick();
        });
      }, FRAME_MS);
    };
    const sync = () => {
      const go = inView && awake && document.visibilityState !== 'hidden';
      if (go && !running) {
        running = true;
        tick();
      } else if (!go && running) {
        running = false;
        window.clearTimeout(timer);
        cancelAnimationFrame(raf);
      }
    };
    const wake = () => {
      window.clearTimeout(idle);
      idle = window.setTimeout(() => {
        awake = false;
        sync();
      }, IDLE_MS);
      if (!awake) {
        awake = true;
        sync();
      }
    };
    const io =
      typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(([entry]) => {
            inView = entry.isIntersecting;
            sync();
          })
        : null;
    io?.observe(canvas);
    const events = ['pointerdown', 'keydown', 'wheel', 'scroll'] as const;
    for (const name of events) window.addEventListener(name, wake, { capture: true, passive: true });
    document.addEventListener('visibilitychange', sync);
    wake();
    sync();
    return () => {
      running = false;
      window.clearTimeout(timer);
      window.clearTimeout(idle);
      cancelAnimationFrame(raf);
      cue?.cancel();
      io?.disconnect();
      for (const name of events) window.removeEventListener(name, wake, { capture: true });
      document.removeEventListener('visibilitychange', sync);
    };
    // One crown, one run: it lights once, from its mount.
  }, []);

  return (
    <span className="foil-crown" aria-hidden="true">
      <canvas ref={ref} />
    </span>
  );
}
