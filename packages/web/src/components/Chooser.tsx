import type { ReactNode } from 'react';
import { progressHeatColor } from '@whippin/shared';
import { isComplete, srStatus, type Status } from '../state/status';
import type { Status as CardStatus } from '../state/status';
// Bundled like the flags (small enough to inline as a data URI — no extra request).
import logo from '../assets/logo-blue.png';

// The app's CHOOSER screen: "which one do you want to play?", asked twice — once about
// the language (/select, the header globe) and once about the daily (/mode, the header
// Whippin mark). Both are ROUTES rather than modals, both are reached from the header,
// and both are the same screen: the logo, then a vertical list of cards carrying an icon,
// a name, and today's status as a strip along the bottom edge.
//
// It lives here as ONE component (2026-08-06) because the second chooser would otherwise
// have been the first one copied — the same shell, the same card, the same strip, drifting
// apart on the next visual decision. A screen supplies only what is its own: what the
// options ARE, what each one is called, which icon it wears and where a tap lands.

// Today's status, spoken in the game's own visual language instead of text badges: a
// thin strip along the card's bottom edge. Absent = not started (NOTHING is the "new"
// signal); partial = today's progress, tinted on the app's one heat ramp; full GOLD =
// done for the day, the same gold as a solved word — whether the day was SOLVED (a
// sentence) or merely finished (a word run's clock, #163), which is a distinction only
// the aria-label makes. Decorative — the card's aria-label carries the status for screen
// readers.
function StatusStrip({ status }: { status: CardStatus }) {
  if (status.kind === 'none') return null;
  const complete = isComplete(status);
  const pct = status.kind === 'progress' ? status.pct : 100;
  return (
    <span
      className="chooser-strip"
      style={{
        width: `${pct}%`,
        background: complete ? 'var(--solve)' : progressHeatColor(pct),
      }}
      aria-hidden="true"
    />
  );
}

// The card's LED MOSAIC (2026-08-18, the /inspiration/modern board — the interfaces.dev
// member card's cell grid): a small field of squares, a deterministic pattern hashed
// from the option's own name, lit in the card's ink. Decorative — the aria-label
// carries everything.
const CELL_COUNT = 24; // 8 × 3
function cellsFor(name: string): boolean[] {
  let h = 2166136261;
  for (const c of name) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return Array.from({ length: CELL_COUNT }, (_, i) => {
    const x = Math.imul(h + Math.imul(i + 1, 2654435761), 40503) >>> 13;
    return x % 8 < 3; // ~38% lit
  });
}

// One option as a MEMBER CARD (2026-08-18, superseding the centred name-only tile): the
// name left-aligned and bold with its index tag under it, the LED mosaic on the right,
// today's status strip on the bottom edge.
export function ChooserCard({
  name,
  tag,
  status,
  uiLang,
  onClick,
}: {
  name: string;
  // The card's small index caption — a language's code (EN/FR), a daily's number (01/02).
  tag?: string;
  status: Status;
  // The chrome language for the spoken status — a chooser has no puzzle to take one from,
  // so its screen resolves it the same way the `/` redirect does.
  uiLang: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="chooser-card"
      aria-label={`${name}${srStatus(uiLang, status)}`}
      onClick={onClick}
    >
      <span className="chooser-card-main">
        <span className="chooser-card-name">{name}</span>
        {tag && <span className="chooser-card-tag">{tag}</span>}
      </span>
      <span className="chooser-cells" aria-hidden="true">
        {cellsFor(name).map((on, i) => (
          // Static decorative pattern: the index is the identity.
          // eslint-disable-next-line react/no-array-index-key
          <i key={i} className={on ? 'on' : undefined} />
        ))}
      </span>
      <StatusStrip status={status} />
    </button>
  );
}

export default function Chooser({ children }: { children: ReactNode }) {
  return (
    <div className="chooser-screen">
      {/* The logo, not a "select X" instruction: the cards self-explain, and on the
          language chooser a title would have to GUESS the user's language on the one
          screen where it is unknown. The logo is language-neutral and this quasi-menu
          screen is the app's one in-app branding spot. The h1 + alt keep the accessible
          name. */}
      <h1 className="chooser-logo-title">
        <img className="chooser-logo" src={logo} alt="Whippin AI" draggable="false" />
      </h1>
      <div className="chooser-list">{children}</div>
    </div>
  );
}
