import { useLayoutEffect, useRef } from 'react';
import { BOARD_PERIODS, type BoardPeriod } from '@whippin/shared';
import { prefersReducedMotion } from '../hooks/useScramble';
import { t } from '../i18n';

// A GROUP'S THREE BOARDS — TODAY, WEEK, MONTH — as three EQUAL CELLS said with the corner
// BRACKETS (the house's selection gesture: the device frame's, the card's, the player's own
// line's), never a box: every word stands in its own resting corners in the slate rail — the
// switch's affordance (bare labels "float in the screen with no purpose, no affordance") — and
// the shown one under the white FRAME, the state. The words are the chrome's voice (`--ui` bold
// tracked capitals), `--muted` but the shown one.
//
// THE BRACKETS TRAVEL from word to word: ONE frame, laid over the shown word's box, moved in
// whole pixels and HARD STEPS (eased out) — the white chip's travel in the tab row above, said
// in the frame's own language. Their first drawing LOCKS ON (the corners close in from outside
// in hard steps, CSS); under reduced motion they are simply there.
const TRAVEL_MS = 180;
const TRAVEL_STEPS = 5;

const LABEL = { day: 'periodDay', week: 'periodWeek', month: 'periodMonth' } as const;

export default function PeriodSwitch({
  lang,
  period,
  onChange,
}: {
  lang: string;
  period: BoardPeriod;
  onChange: (period: BoardPeriod) => void;
}) {
  const lineRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLSpanElement>(null);
  const box = useRef<{ x: number; w: number } | null>(null);
  const travel = useRef<Animation | null>(null);
  const shown = BOARD_PERIODS.indexOf(period);

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
      const frames: Keyframe[] = [];
      for (let k = 0; k <= TRAVEL_STEPS; k += 1) {
        const at = k / TRAVEL_STEPS;
        const e = 1 - (1 - at) * (1 - at);
        frames.push({
          left: `${Math.round(prev.x + (next.x - prev.x) * e)}px`,
          width: `${Math.round(prev.w + (next.w - prev.w) * e)}px`,
          offset: at,
          easing: 'steps(1, end)',
        });
      }
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
    <nav className="period-switch" aria-label={t(lang, 'boardPeriods')}>
      <div ref={lineRef} className="period-line">
        {BOARD_PERIODS.map((view) => (
          <button
            key={view}
            type="button"
            className={`period-word${view === period ? ' on' : ''}`}
            aria-current={view === period || undefined}
            onClick={() => view !== period && onChange(view)}
          >
            <span data-focus-box>{t(lang, LABEL[view])}</span>
          </button>
        ))}
        <span ref={frameRef} className="period-frame" aria-hidden="true">
          <i className="tl" />
          <i className="tr" />
          <i className="bl" />
          <i className="br" />
        </span>
      </div>
    </nav>
  );
}
