import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { activeDate, dayNumber, progressColor } from '@whippin/shared';
import TopBar from '../components/TopBar';
import { navigate } from '../routing';
import { pathForMode, pathForDay, type LangCode, type Mode } from '../langs';
import { FIRST_PUZZLE_DATE } from '../config';
import { useGameStore, roundKeyForDay } from '../state/gameStore';
import { isComplete, statusOf, wordStatusOf, srStatus, type Status } from '../state/status';
import { currentStreak } from '../game/streak';
import useToday from '../hooks/useToday';
import streakSmall from '../assets/streak-small.png';
import { t } from '../i18n';
import {
  yearMonthOf,
  compareYearMonth,
  addMonths,
  clampYearMonth,
  monthGrid,
  type YearMonth,
} from '../calendar';
// Inline SVG (vite-plugin-svgr): renders into the DOM and paints with currentColor, so
// it inherits the header control's tint. Decorative — the button's aria-label names it.
import CloseIcon from '../assets/icons/close.svg?react';

// The locale's first weekday (0 = Sunday … 6 = Saturday). Prefers Intl's `weekInfo`
// (fr weeks start Monday, en-US Sunday); falls back to a per-language default where it
// is unsupported. Locales own week layout, not i18n.ts.
function firstDayOfWeek(lang: string): number {
  try {
    const loc = new Intl.Locale(lang) as Intl.Locale & {
      weekInfo?: { firstDay?: number };
      getWeekInfo?: () => { firstDay?: number };
    };
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info?.firstDay) return info.firstDay % 7; // 1=Mon..7=Sun -> 0=Sun..6=Sat
  } catch {
    /* Intl.Locale / weekInfo unsupported here — use the language default below. */
  }
  return lang === 'fr' ? 1 : 0;
}

// The archive calendar (#55): one month of playable past days at a time. Each cell is a
// flat key that navigates to that day's game (/<lang>/<date>); days before the first
// puzzle or after the client's active day are disabled. Per-cell status (solved / in
// progress / not started) is read from the persisted rounds — device-local, as intended.
const NO_SOLVED_DAYS: number[] = [];

// `mode` (#156): each daily has its own archive face — a Word mode cell reads its
// status from the word rounds and navigates to /<lang>/word/<date>, so the two dailies'
// histories never blur into one calendar.
export default function Archive({ lang, mode = 'sentence' }: { lang: LangCode; mode?: Mode }) {
  const rounds = useGameStore((s) => s.rounds);
  const wordRounds = useGameStore((s) => s.wordRounds);

  // The live streak — displayed HERE (the player-history screen), above the calendar
  // it is derived from (moved from the header, decided 2026-07-21). Hidden at zero.
  const activeDay = useToday();
  const solvedDays = useGameStore((s) => s.solvedDays[lang] ?? NO_SOLVED_DAYS);
  const streak = currentStreak(solvedDays, activeDay);

  // The window of playable days: [FIRST_PUZZLE_DATE, the client's active game day]. Both
  // are ISO labels, so cells compare against them by string order (offset-free).
  const today = useMemo(() => activeDate(new Date()), []);
  const firstMonth = useMemo<YearMonth>(() => yearMonthOf(FIRST_PUZZLE_DATE), []);
  const activeMonth = useMemo<YearMonth>(() => yearMonthOf(today), [today]);

  // The month on screen, clamped into range (start on the current month).
  const [current, setCurrent] = useState<YearMonth>(() =>
    clampYearMonth(activeMonth, firstMonth, activeMonth),
  );

  const canPrev = compareYearMonth(current, firstMonth) > 0;
  const canNext = compareYearMonth(current, activeMonth) < 0;
  const step = (delta: number) =>
    setCurrent((c) => clampYearMonth(addMonths(c, delta), firstMonth, activeMonth));

  // Locale-owned chrome: the month title, the weekday header letters (in the locale's
  // week order), and the per-cell long date for aria-labels. All UTC so a cell's label
  // matches its ISO date exactly.
  const weekStart = useMemo(() => firstDayOfWeek(lang), [lang]);
  const monthTitle = useMemo(
    () =>
      new Intl.DateTimeFormat(lang, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
        new Date(Date.UTC(current.year, current.month - 1, 1)),
      ),
    [lang, current],
  );
  const weekdayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(lang, { weekday: 'narrow', timeZone: 'UTC' });
    // Jan 1 2023 is a Sunday — offset it to each weekday in the locale's order.
    return Array.from({ length: 7 }, (_, i) =>
      fmt.format(new Date(Date.UTC(2023, 0, 1 + ((weekStart + i) % 7)))),
    );
  }, [lang, weekStart]);
  const longDate = useMemo(
    () => new Intl.DateTimeFormat(lang, { dateStyle: 'long', timeZone: 'UTC' }),
    [lang],
  );

  const cells = useMemo(() => monthGrid(current, weekStart), [current, weekStart]);

  return (
    <div className="archive">
      <TopBar
        lang={lang}
        left={<span className="topbar-title">{t(lang, 'archive')}</span>}
        right={
          <button
            type="button"
            className="home-btn archive-close"
            aria-label={t(lang, 'ariaBackToToday')}
            onClick={() => navigate(pathForMode(lang, mode))}
          >
            <CloseIcon className="pixel-icon" aria-hidden />
          </button>
        }
      />

      {/* The streak hero: flame + count above the calendar the streak is made of —
          a stat headline, no label (the flame IS the label). Hidden when zero — and on
          Word mode's archive face, whose runs don't feed the streak (#156, out of
          scope beyond what the round key gives for free). */}
      {mode === 'sentence' && streak > 0 && (
        <div className="archive-streak">
          <img src={streakSmall} className="archive-streak-flame" alt="" />
          <span className="sr-only">{t(lang, 'streak')} </span>
          <span className="archive-streak-count">{streak}</span>
        </div>
      )}

      <div className="cal">
        {/* Month navigation, clamped to [first puzzle month, current month]. */}
        <div className="cal-nav">
          <button
            type="button"
            className="cal-arrow"
            aria-label={t(lang, 'ariaPrevMonth')}
            aria-disabled={!canPrev}
            disabled={!canPrev}
            onClick={() => canPrev && step(-1)}
          >
            {'<'}
          </button>
          <span className="cal-month">{monthTitle}</span>
          <button
            type="button"
            className="cal-arrow"
            aria-label={t(lang, 'ariaNextMonth')}
            aria-disabled={!canNext}
            disabled={!canNext}
            onClick={() => canNext && step(1)}
          >
            {'>'}
          </button>
        </div>

        {/* Weekday header — decorative (each day cell carries the full date). */}
        <div className="cal-grid cal-weekdays" aria-hidden="true">
          {weekdayLabels.map((label, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <span key={i} className="cal-weekday">
              {label}
            </span>
          ))}
        </div>

        <div className="cal-grid">
          {cells.map((date, i) =>
            date === null ? (
              // eslint-disable-next-line react/no-array-index-key
              <span key={`pad-${i}`} className="cal-pad" aria-hidden="true" />
            ) : (
              <DayCell
                key={date}
                date={date}
                lang={lang}
                mode={mode}
                inRange={date >= FIRST_PUZZLE_DATE && date <= today}
                isToday={date === today}
                status={
                  mode === 'word'
                    ? wordStatusOf(wordRounds[roundKeyForDay(dayNumber(date), lang, 'word')])
                    : statusOf(rounds[roundKeyForDay(dayNumber(date), lang)])
                }
                longDate={longDate}
              />
            ),
          )}
        </div>
      </div>
    </div>
  );
}

// One day: a flat key that navigates to that day's game when in range, disabled (dimmed)
// otherwise. A day with any reconstruction (>0%) is FILLED with its progress-ramp color
// (solved = 100%), and its number is drawn in the app background color so it reads on the
// fill; disabled and not-started/0% days stay the neutral surface. A SOLVED day also
// carries the shading ripple — an `ultracode.png` 12-frame sprite animated in CSS
// (.cal-ripple) — so a validated day differs from an in-progress one by MOTION, not only
// color. The aria-label speaks the full date + status.
function DayCell({
  date,
  lang,
  mode,
  inRange,
  isToday,
  status,
  longDate,
}: {
  date: string;
  lang: LangCode;
  mode: Mode;
  inRange: boolean;
  isToday: boolean;
  status: Status;
  longDate: Intl.DateTimeFormat;
}) {
  const day = Number(date.slice(8, 10));
  const dateObj = new Date(`${date}T00:00:00Z`);
  // Reconstruction %: a finished day counts as 100, not-started as 0. Only an in-range
  // day with progress is filled; disabled and 0% days keep the neutral surface + number
  // color. A word run finished by its clock (#163) reads as complete here exactly like a
  // solved sentence — the ripple says "done for the day", not "solved".
  const pct = isComplete(status) ? 100 : status.kind === 'progress' ? status.pct : 0;
  const filled = inRange && pct > 0;
  const solved = inRange && isComplete(status);
  const className =
    'cal-day' +
    (inRange ? '' : ' cal-day-disabled') +
    (isToday ? ' cal-day-today' : '') +
    (filled ? ' cal-day-filled' : '') +
    (solved ? ' cal-day-solved' : '');
  return (
    <button
      type="button"
      className={className}
      aria-label={`${longDate.format(dateObj)}${srStatus(lang, status)}`}
      aria-disabled={!inRange}
      disabled={!inRange}
      onClick={() => inRange && navigate(pathForDay(lang, date, mode))}
      // Only the fill color is dynamic (per-day %); the bg-colored number is static CSS
      // (.cal-day-filled). Neutral days pass no style, so the surface default stands.
      style={filled ? ({ background: progressColor(pct) } as CSSProperties) : undefined}
    >
      {/* A solved day ripples (motion differentiates it from an in-progress day). */}
      {solved && <span className="cal-ripple" aria-hidden="true" />}
      <span className="cal-day-num">{day}</span>
    </button>
  );
}
