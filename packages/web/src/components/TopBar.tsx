import type { ReactNode } from 'react';
import FlagButton from './FlagButton';
import streakSmall from '../assets/streak-small.png';
import useToday from '../hooks/useToday';
import { currentStreak } from '../game/streak';
import { useGameStore } from '../state/gameStore';
import { t } from '../i18n';

const NO_SOLVED_DAYS: number[] = [];

// The app header: language flag + live streak on the left, a centered title, and a
// right-hand control — separated from the app by a thin bottom border. Shared by the
// game, archive, and tutorial, so the player-level streak stays in one consistent place.
// The center title is ABSOLUTELY centered (out of flex flow) so it never drifts with the
// side controls' widths.
export default function TopBar({
  lang,
  center,
  right,
}: {
  lang: string;
  center?: ReactNode;
  right?: ReactNode;
}) {
  const activeDay = useToday();
  const solvedDays = useGameStore((state) => state.solvedDays[lang] ?? NO_SOLVED_DAYS);
  const streak = currentStreak(solvedDays, activeDay);

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="topbar-left">
          <FlagButton lang={lang} />
          {streak > 0 && (
            <span className="topbar-streak">
              {/* The flame sits in a hud-height square box, like the flag and the right-hand
                  icons — so all header glyphs share one footprint. */}
              <span className="topbar-streak-flame-box" aria-hidden>
                <img src={streakSmall} className="topbar-streak-flame" alt="" />
              </span>
              <span className="sr-only">{t(lang, 'streak')} </span>
              <span className="topbar-streak-count">{streak}</span>
            </span>
          )}
        </div>
        {center}
        {right}
      </div>
    </header>
  );
}
