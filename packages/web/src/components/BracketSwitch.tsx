import { useLayoutEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { travelFrames } from './travel';
import { prefersReducedMotion } from '../hooks/useScramble';

// A FEW STATES OF ONE THING, as EQUAL CELLS said with the corner BRACKETS (the house's
// selection gesture: the device frame's, the card's), never a box:
// every word stands in its own resting corners in the slate rail — the switch's affordance
// (bare labels "float in the screen with no purpose, no affordance") — and the shown one under
// the white FRAME, the state. The words are the chrome's voice (`--ui` bold tracked capitals),
// `--muted` but the shown one. A group's three boards (`PeriodSwitch`) and an article figure's
// states (its AVANT / APRÈS) turn through it: one control, one dress.
//
// THE BRACKETS TRAVEL from word to word: ONE frame, laid over the shown word's box, moved in
// whole pixels and HARD STEPS (eased out) — the white chip's travel in the board's tab row,
// said in the frame's own language. Their first drawing LOCKS ON (the corners close in from
// outside in hard steps, CSS); under reduced motion they are simply there.
//
// What a state IS to a reader is the caller's: a board's period is the CURRENT one
// (`aria-current`, inside its own `<nav>`), a figure's state a PRESSED button (`pressed`).
const TRAVEL_MS = 180;
const TRAVEL_STEPS = 5;

export default function BracketSwitch({
  labels,
  shown,
  onPick,
  pressed = false,
}: {
  labels: readonly string[];
  shown: number;
  onPick: (index: number) => void;
  pressed?: boolean;
}) {
  const lineRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLSpanElement>(null);
  const box = useRef<{ x: number; w: number } | null>(null);
  const travel = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const line = lineRef.current;
    const frame = frameRef.current;
    const seat = (animate: boolean) => {
      const button = line?.children[shown] as HTMLElement | undefined;
      if (!line || !frame || !button) return;
      const next = { x: button.offsetLeft, w: button.offsetWidth };
      const prev = box.current;
      box.current = next;
      frame.style.left = `${next.x}px`;
      frame.style.width = `${next.w}px`;
      if (!animate || prev === null || (prev.x === next.x && prev.w === next.w) || prefersReducedMotion()) return;
      travel.current?.cancel();
      const frames = travelFrames(TRAVEL_STEPS, (e) => ({
        left: `${Math.round(prev.x + (next.x - prev.x) * e)}px`,
        width: `${Math.round(prev.w + (next.w - prev.w) * e)}px`,
      }));
      travel.current = frame.animate(frames, { duration: TRAVEL_MS });
    };
    seat(true);
    // The words' widths move when the web font lands: re-seat, never travel.
    if (!line || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => seat(false));
    ro.observe(line);
    return () => ro.disconnect();
  }, [shown]);

  return (
    <div ref={lineRef} className="period-line" style={{ '--n': labels.length } as CSSProperties}>
      {labels.map((label, i) => (
        <button
          key={label}
          type="button"
          className={`period-word${i === shown ? ' on' : ''}`}
          aria-current={!pressed && i === shown ? true : undefined}
          aria-pressed={pressed ? i === shown : undefined}
          onClick={() => i !== shown && onPick(i)}
        >
          <span data-focus-box>{label}</span>
        </button>
      ))}
      <span ref={frameRef} className="period-frame" aria-hidden="true">
        <i className="tl" />
        <i className="tr" />
        <i className="bl" />
        <i className="br" />
      </span>
    </div>
  );
}
