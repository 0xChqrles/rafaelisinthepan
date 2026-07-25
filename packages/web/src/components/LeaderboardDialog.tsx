import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import RunRuler, { rulerStagger } from './RunRuler';
import CloseIcon from '../assets/icons/close.svg?react';
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

  const maxN = Math.max(...rows.map((r) => r.trajectory.length), 1);
  const stagger = rulerStagger(maxN);

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events
    <dialog
      ref={dialogRef}
      className="lb-dialog"
      onClose={onClose}
      onClick={(e) => {
        // A click on the dialog element itself is the backdrop area outside the frame.
        if (e.target === dialogRef.current) dialogRef.current?.close();
      }}
    >
      <button
        type="button"
        className="lb-dialog-close"
        aria-label={t(lang, 'ariaClose')}
        onClick={() => dialogRef.current?.close()}
      >
        <CloseIcon className="pixel-icon" aria-hidden />
      </button>
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
                  maxN={maxN}
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
          {rows.map((row, i) => `${i + 1}. ${row.label} ${row.tries ?? t(lang, 'dnf')}`).join(' · ')}
        </p>
      </div>
    </dialog>
  );
}
