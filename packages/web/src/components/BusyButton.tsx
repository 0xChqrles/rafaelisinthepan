import { useLayoutEffect, useRef, type ButtonHTMLAttributes, type CSSProperties } from 'react';
import { SKELETON_WAIT_MS } from './bayerTiles';
import { t } from '../i18n';

// The stipple's cell (`bayerTiles.ts`): the word's clearing is cut on it.
const CELL = 2;
// The clearing's air round the word: two cells above and below, four a side.
const AIR_Y = 2 * CELL;
const AIR_X = 4 * CELL;
// A layout length one LayoutUnit off a whole cell still lands on it.
const EPS = 0.01;

// A BUTTON WHOSE ACT IS OUT — the app's ONE busy dress (the gate's PLAY, JOIN, CONTINUE, the
// crossroads' answers, CREATE GROUP, the confirmations' acts, the profile's SAVE). The button
// animates, it never renames itself: the act's word stays at full ink while the request runs.
// Busy, it answers no tap but keeps the keyboard's focus (`aria-disabled`, not `disabled`, so
// it is never dimmed as unavailable), says so to a screen reader (`aria-busy` and the sr-only
// `loading`), and — only once the wait has lasted `SKELETON_WAIT_MS`, so a quick answer shows
// nothing — its wash turns into the house stipple in its own ink, breathing in hard steps,
// the word standing in a clearing of it (`index.css`, "A BUSY BUTTON"). The outcome is the
// act's own: the keyboard rising, the name inked in, the foil stamp, the next step.
export default function BusyButton({
  busy,
  lang,
  type = 'button',
  style,
  onClick,
  children,
  'aria-disabled': ariaDisabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { busy: boolean; lang: string }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);

  // THE CLEARING ON WHOLE CELLS. The stipple is tiled from the button's padding box, but the
  // word sits wherever centring puts it — half a pixel off a cell, and its width is the
  // type's, not the grid's. So, busy, the word's box is measured against the padding box and
  // the clearing round it rounded OUTWARD to whole cells, before the first busy frame paints
  // and again whenever the button changes size (the word moving with its centre). The box
  // ends on the last letter's tracking, which is air: the clearing is measured off the ink.
  useLayoutEffect(() => {
    const button = buttonRef.current;
    const label = labelRef.current;
    if (!busy || !button || !label) return undefined;
    const place = () => {
      const box = button.getBoundingClientRect();
      const word = label.getBoundingClientRect();
      const tracking = parseFloat(getComputedStyle(label).letterSpacing) || 0;
      const left = word.left - box.left - button.clientLeft;
      const top = word.top - box.top - button.clientTop;
      const x0 = Math.floor((left - AIR_X) / CELL + EPS) * CELL;
      const y0 = Math.floor((top - AIR_Y) / CELL + EPS) * CELL;
      const x1 = Math.ceil((left + word.width - tracking + AIR_X) / CELL - EPS) * CELL;
      const y1 = Math.ceil((top + word.height + AIR_Y) / CELL - EPS) * CELL;
      button.style.setProperty('--clear-x', `${x0}px`);
      button.style.setProperty('--clear-y', `${y0}px`);
      button.style.setProperty('--clear-w', `${x1 - x0}px`);
      button.style.setProperty('--clear-h', `${y1 - y0}px`);
    };
    place();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    ro?.observe(button);
    return () => ro?.disconnect();
  }, [busy]);

  return (
    <button
      ref={buttonRef}
      type={type}
      {...props}
      style={busy ? ({ ...style, '--busy-wait': `${SKELETON_WAIT_MS}ms` } as CSSProperties) : style}
      aria-disabled={busy || ariaDisabled || undefined}
      aria-busy={busy || undefined}
      onClick={(event) => {
        // A submit button included: busy, the tap does nothing at all.
        if (busy) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      <span ref={labelRef} className="busy-label">
        {children}
      </span>
      {busy && <span className="sr-only">{t(lang, 'loading')}</span>}
    </button>
  );
}
