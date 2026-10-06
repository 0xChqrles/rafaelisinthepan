import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { watchRaster } from '../../../components/rasterWatch';
import { prefersReducedMotion } from '../../../hooks/useScramble';
import { CELL, CellCanvas, lineCells, type Cells } from './cells';
import useSeen from './useSeen';

// THE TRAINING LOOP: the steps in order, each a note in a sentence, and from the last a slate
// stipple back up into the first — the flow's rail, ending in an arrowhead on 01: the "on
// recommence" the caption says, drawn, standing still whatever the motion setting. Once the
// figure is on screen the WHITE TITLE CHIP — the one emphasis gesture, the boards' shown tab —
// stands on the step being done, then HOPS to the next: unwiped off its step, wiped onto the
// next one, in hard steps, never crossing the steps between — and from the last back to the
// first. The chip is ONE white sheet over the list carrying its words again in the ground's
// ink, clipped to the step it stands on. Its clock RESTS while nobody can see it — scrolled out
// of view, the tab hidden (`rasterWatch`) — and picks up on the step it stood on. Under reduced
// motion no step is lit; the rail still says it starts over.
const HOLD_MS = 1100;
const WIPE_MS = 180;
const WIPE_STEPS = 6;
// The chip round the words' line box (18px): a 24px band.
const CHIP_X = 7;
const CHIP_Y = 3;
// The return's arrowhead, in cells: its depth (a column each, 1, 3, 5, 7 cells tall).
const HEAD = 4;
// Air between the rail's end and a step's number, in cells.
const RAIL_AIR = 3;

type Box = { top: number; left: number; width: number; height: number };

function Steps({ steps }: { steps: string[] }) {
  return (
    <>
      {steps.map((step, i) => (
        <li key={step} className="ar-loop-step">
          <span className="ar-loop-no">{String(i + 1).padStart(2, '0')}</span>
          <span className="ar-loop-text" data-step={i}>
            {step}
          </span>
        </li>
      ))}
    </>
  );
}

export default function Loop({ steps }: { steps: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const inkRef = useRef<HTMLOListElement>(null);
  const seen = useSeen(ref);
  const [lit, setLit] = useState(-1);
  const box = useRef<Box | null>(null);
  const hop = useRef<Animation | null>(null);
  // The return's raster: the first and last numbers' middle rows and where the numbers start,
  // in cells — measured off the page, since a step's words wrap as the column narrows.
  const [rail, setRail] = useState<{ rows: number; end: number; top: number; bottom: number } | null>(null);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return undefined;
    const measure = () => {
      const nos = root.querySelectorAll<HTMLElement>('.ar-loop-base .ar-loop-no');
      const first = nos[0];
      const last = nos[nos.length - 1];
      if (!first || !last) return;
      const r = root.getBoundingClientRect();
      const mid = (el: HTMLElement) => {
        const b = el.getBoundingClientRect();
        return Math.round((b.top + b.height / 2 - r.top) / CELL);
      };
      const end = Math.floor((first.getBoundingClientRect().left - r.left) / CELL) - RAIL_AIR;
      const next = { rows: Math.ceil(r.height / CELL), end, top: mid(first), bottom: mid(last) };
      setRail((was) =>
        was && was.rows === next.rows && was.end === next.end && was.top === next.top && was.bottom === next.bottom
          ? was
          : next,
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [steps]);

  const drawRail = useCallback(
    (cells: Cells) => {
      if (!rail) return;
      const { end, top, bottom } = rail;
      const tip = end - 1;
      // Out of the last step, up the left edge, into the first: one stipple, a cell in three.
      const run = [
        ...lineCells(tip - HEAD, bottom, 0, bottom),
        ...lineCells(0, bottom - 1, 0, top + 1),
        ...lineCells(0, top, tip - HEAD, top),
      ];
      run.forEach(([x, y], k) => k % 3 === 0 && cells.set(x, y, 'rail'));
      // Its corners stand whole, so the turn reads.
      cells.set(0, bottom, 'rail');
      cells.set(0, top, 'rail');
      // The arrowhead on 01.
      for (let d = 0; d < HEAD; d += 1) cells.block(tip - d, top - d, 1, 2 * d + 1, 'rail');
    },
    [rail],
  );

  // The clock: a step every HOLD_MS while somebody can see the figure.
  useEffect(() => {
    const root = ref.current;
    if (!seen || !root || prefersReducedMotion()) return undefined;
    let timer = 0;
    const tick = () => {
      timer = 0;
      if (!watch.seen()) return;
      setLit((i) => (i + 1) % steps.length);
      timer = window.setTimeout(tick, HOLD_MS);
    };
    const watch = watchRaster(root, () => {
      if (timer === 0 && watch.seen()) timer = window.setTimeout(tick, HOLD_MS);
    });
    setLit((i) => (i < 0 ? 0 : i));
    timer = window.setTimeout(tick, HOLD_MS);
    return () => {
      window.clearTimeout(timer);
      watch.stop();
    };
  }, [seen, steps.length]);

  // The chip: the white sheet's clip, seated on the lit step's words (its own padding round
  // them) — its first drawing WIPED on (the tab row's own beat), every later one a HOP.
  useLayoutEffect(() => {
    const root = ref.current;
    const ink = inkRef.current;
    if (!root || !ink || lit < 0) return undefined;
    const seat = (animate: boolean) => {
      const text = root.querySelector<HTMLElement>(`.ar-loop-base [data-step="${lit}"]`);
      if (!text) return;
      const r = root.getBoundingClientRect();
      // The words' own box: a step that wraps is as wide as its longest line, not its column.
      const range = document.createRange();
      range.selectNodeContents(text);
      const t = range.getBoundingClientRect();
      const next = {
        top: Math.round(t.top - r.top) - CHIP_Y,
        left: Math.round(t.left - r.left) - CHIP_X,
        width: Math.round(t.width) + 2 * CHIP_X,
        height: Math.round(t.height) + 2 * CHIP_Y,
      };
      const clip = (b: Box) =>
        `inset(${b.top}px ${r.width - b.left - b.width}px ${r.height - b.top - b.height}px ${b.left}px)`;
      // A chip with no width, at a step's start (wiping on) or its end (unwiped off).
      const start = (b: Box) => ({ ...b, width: 0 });
      const gone = (b: Box) => ({ ...b, left: b.left + b.width, width: 0 });
      const prev = box.current;
      box.current = next;
      ink.style.clipPath = clip(next);
      // A re-seat (the column resized, the font landed) leaves a hop in flight to finish.
      if (!animate) return;
      hop.current?.cancel();
      const stepped = `steps(${WIPE_STEPS}, jump-end)`;
      hop.current =
        prev === null
          ? ink.animate([{ clipPath: clip(start(next)) }, { clipPath: clip(next) }], { duration: WIPE_MS, easing: stepped })
          : ink.animate(
              [
                { offset: 0, clipPath: clip(prev), easing: stepped },
                { offset: 0.5, clipPath: clip(gone(prev)) },
                { offset: 0.5, clipPath: clip(start(next)), easing: stepped },
                { offset: 1, clipPath: clip(next) },
              ],
              { duration: 2 * WIPE_MS },
            );
    };
    seat(true);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => seat(false));
    ro.observe(root);
    return () => ro.disconnect();
  }, [lit]);

  return (
    <div ref={ref} className="ar-loop">
      {rail && rail.end > HEAD && (
        <CellCanvas className="ar-loop-rail" cols={rail.end} rows={rail.rows} draw={drawRail} />
      )}
      <ol className="ar-loop-base">
        <Steps steps={steps} />
      </ol>
      <ol ref={inkRef} className={`ar-loop-ink${lit < 0 ? '' : ' on'}`} aria-hidden="true">
        <Steps steps={steps} />
      </ol>
    </div>
  );
}
