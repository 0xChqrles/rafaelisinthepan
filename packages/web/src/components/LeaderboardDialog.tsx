import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n';
import RunRuler, { rulerStagger } from './RunRuler';
import ModalHeader from './ModalHeader';
import medal1 from '../assets/medals/1.png';
import medal2 from '../assets/medals/2.png';
import medal3 from '../assets/medals/3.png';
import medal4 from '../assets/medals/4.png';

// Placement medals (15×15 pixel art, drawn on the heat ramp's four anchor stops:
// 1 hot cyan → 4 cold crimson), rendered at an exact 2× like the other sprites.
const MEDALS = [medal1, medal2, medal3, medal4];

// One leaderboard entrant, already sorted (player ahead on a tie, DNF last) and
// replayed by the solved screen: identity + count + its run for the ruler.
export interface LeaderboardRow {
  key: string;
  tag: string;
  label: string;
  tries: number | null;
  player: boolean;
  trajectory: number[];
  solvedAt: (number | null)[];
}

// How long the neutral tiles hold before the colorize wave sweeps the freshly
// opened table.
const COLORIZE_DELAY_MS = 150;

// The full leaderboard behind the solved tray's SEE MORE (decided 2026-07-25,
// superseding the inline #110 table): a borderless full-screen native dialog on the
// SOLID app background — the animated noise never plays under it — with generous row
// rhythm. One row per entrant: medal, tag over its run ruler, count (DNF muted).
// This surface is the planned home of the deeper result views (#82): per-row runs,
// tested words, per-hole word lists. Closes via the X, Escape, or a backdrop click.
export default function LeaderboardDialog({
  rows,
  lang,
  onClose,
}: {
  rows: LeaderboardRow[];
  lang: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [colorized, setColorized] = useState(false);
  const reduceMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Mounted = open: show the modal and replay the colorize wave shortly after.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    if (!dialog.open) dialog.showModal();
    if (reduceMotion) {
      setColorized(true);
      return undefined;
    }
    const id = window.setTimeout(() => setColorized(true), COLORIZE_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [reduceMotion]);

  // The shared scale comes from the longest SOLVED run, NOT the longest run on the table:
  // a DNF's run is not a score, it simply ends at the harness's counted-try cap (300 by
  // default), so scaling to it would squeeze every real bar — the player's included — into
  // a few pixels. A DNF therefore overflows the scale and the ruler's own min(…, 1) clamps
  // it to full width, which reads correctly: it ran the longest and still didn't finish.
  // The colorize wave, though, still has to sweep every CELL on screen within its span, so
  // its stagger is paced by the longest run of all.
  const cellMax = Math.max(...rows.map((r) => r.trajectory.length), 1);
  const scaleMax = Math.max(
    ...rows.filter((r) => r.tries !== null).map((r) => r.trajectory.length),
    1,
  );
  const stagger = rulerStagger(cellMax, reduceMotion);

  // PORTALLED to <body>: the trigger lives inside .solved-results, which always carries a
  // transform (its rise-in). A transformed ancestor is a containing block for fixed
  // positioning, and while a top-layer dialog is specified to escape that, it is exactly
  // the kind of rule engines have disagreed on — a full-screen surface that silently
  // becomes a 680px box is not a risk worth carrying for one import.
  return createPortal(
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events
    <dialog
      ref={dialogRef}
      className="lb-dialog"
      // The table is decorative; this names the surface itself, so the dialog does not
      // announce as an anonymous one.
      aria-label={t(lang, 'leaderboard')}
      onClose={onClose}
      onClick={(e) => {
        // Everything AROUND the table dismisses. Two elements can be hit directly now that the
        // SCROLLER (not the dialog) owns the overflow — the header has to sit in flow above
        // something: the dialog itself, and the scroller, which is the margin around the
        // centred frame and so most of the backdrop.
        if (e.target === dialogRef.current || e.target === scrollRef.current) {
          dialogRef.current?.close();
        }
      }}
    >
      {/* The shared modal chrome (see ModalHeader), replacing this dialog's own X floated in
          the corner (2026-07-27): the app had two full-screen modals wearing two different
          dismissal chromes, and only the route map's was the app's own row. */}
      <ModalHeader
        lang={lang}
        title={t(lang, 'leaderboard')}
        onClose={() => dialogRef.current?.close()}
      />

      <div className="lb-scroll" ref={scrollRef}>
        <div className="lb-dialog-frame">
          <div className="leaderboard" aria-hidden="true">
            {rows.map((row, i) => (
              <div key={row.key} className="lb-row">
                <img className="lb-medal" src={MEDALS[Math.min(i, MEDALS.length - 1)]} alt="" />
                {/* Tag + ruler wrapper: display:contents on desktop (they stay separate
                    subgrid columns); on mobile it becomes a stacked column — the tag sits
                    ABOVE the bar's left edge, freeing its column for the bar. */}
                <div className="lb-main">
                  <span className={`lb-tag${row.player ? ' player' : ''}`}>{row.tag}</span>
                  <RunRuler
                    trajectory={row.trajectory}
                    solvedAt={row.solvedAt}
                    maxN={scaleMax}
                    stagger={stagger}
                    shown
                    colorized={colorized}
                  />
                </div>
                <span className={`lb-score${row.tries === null ? ' dnf' : ''}`}>
                  {row.tries ?? t(lang, 'dnf')}
                </span>
              </div>
            ))}
          </div>
          {/* The table is decorative — this line carries the accessible ranking. */}
          <p className="sr-only">
            {rows
              .map((row, i) => `${i + 1}. ${row.label} ${row.tries ?? t(lang, 'dnf')}`)
              .join(' · ')}
          </p>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
