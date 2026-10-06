import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { travelFrames } from '../../../components/travel';
import { prefersReducedMotion } from '../../../hooks/useScramble';
import useSeen from './useSeen';

// THE TRAINING LOOP: the steps in order, in the chrome's voice, and the WHITE TITLE CHIP — the
// one emphasis gesture, the boards' shown tab — standing on the step being done, then
// TRAVELLING to the next in whole pixels and hard steps (the tab row's own travel), and from
// the last back up to the first: the "on recommence" the caption says, shown. Like the tab
// row's, the chip is ONE white sheet over the list carrying its words again in the ground's
// ink, clipped to the step it stands on, so it inverts exactly the letters it crosses on the
// way. It starts once the figure is on screen, its first drawing WIPED across the words (the
// tab row's own beat); under reduced motion no step is lit.
const HOLD_MS = 1100;
const TRAVEL_MS = 220;
const TRAVEL_STEPS = 6;
const WIPE_MS = 240;
const WIPE_STEPS = 8;
// The chip round the words' line box (15px at 12px): the header title chip's 21px band.
const CHIP_X = 7;
const CHIP_Y = 3;

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
  const travel = useRef<Animation | null>(null);

  useEffect(() => {
    if (!seen || prefersReducedMotion()) return undefined;
    setLit(0);
    const id = window.setInterval(() => setLit((i) => (i + 1) % steps.length), HOLD_MS);
    return () => window.clearInterval(id);
  }, [seen, steps.length]);

  // The chip: the white sheet's clip, seated on the lit step's words (its own padding round
  // them) and travelling there from where it stood.
  useLayoutEffect(() => {
    const root = ref.current;
    const ink = inkRef.current;
    if (!root || !ink || lit < 0) return undefined;
    const seat = (animate: boolean) => {
      const text = root.querySelector<HTMLElement>(`.ar-loop-base [data-step="${lit}"]`);
      if (!text) return;
      const r = root.getBoundingClientRect();
      const t = text.getBoundingClientRect();
      const next = {
        top: Math.round(t.top - r.top) - CHIP_Y,
        left: Math.round(t.left - r.left) - CHIP_X,
        width: Math.round(t.width) + 2 * CHIP_X,
        height: Math.round(t.height) + 2 * CHIP_Y,
      };
      const clip = (b: Box) =>
        `inset(${b.top}px ${r.width - b.left - b.width}px ${r.height - b.top - b.height}px ${b.left}px)`;
      const prev = box.current;
      box.current = next;
      ink.style.clipPath = clip(next);
      if (!animate) return;
      travel.current?.cancel();
      // Its first drawing: the chip WIPED across the words, left to right.
      if (prev === null) {
        travel.current = ink.animate([{ clipPath: clip({ ...next, width: 0 }) }, { clipPath: clip(next) }], {
          duration: WIPE_MS,
          easing: `steps(${WIPE_STEPS}, jump-end)`,
        });
        return;
      }
      travel.current = ink.animate(
        travelFrames(TRAVEL_STEPS, (e) =>
          ({
            clipPath: clip({
              top: Math.round(prev.top + (next.top - prev.top) * e),
              left: Math.round(prev.left + (next.left - prev.left) * e),
              width: Math.round(prev.width + (next.width - prev.width) * e),
              height: Math.round(prev.height + (next.height - prev.height) * e),
            }),
          }) as Keyframe,
        ),
        { duration: TRAVEL_MS },
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
      <ol className="ar-loop-base">
        <Steps steps={steps} />
      </ol>
      <ol ref={inkRef} className={`ar-loop-ink${lit < 0 ? '' : ' on'}`} aria-hidden="true">
        <Steps steps={steps} />
      </ol>
    </div>
  );
}
