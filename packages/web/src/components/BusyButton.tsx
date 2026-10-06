import type { ButtonHTMLAttributes, CSSProperties } from 'react';
import { SKELETON_WAIT_MS } from './bayerTiles';
import { t } from '../i18n';

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
  return (
    <button
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
      <span className="busy-label">{children}</span>
      {busy && <span className="sr-only">{t(lang, 'loading')}</span>}
    </button>
  );
}
