import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { activeDate, dayNumber, progressHeatColor } from '@whippin/shared';
import TopBar from '../components/TopBar';
import ModeTabs from '../components/ModeTabs';
import { navigate } from '../routing';
import { pathForMode, pathForDay, pathForArchive, type LangCode, type Mode } from '../langs';
import { FIRST_PUZZLE_DATE } from '../config';
import { useGameStore, roundKeyForDay } from '../state/gameStore';
import { daySummaryStatus, usePlayerHistory } from '../state/history';
import { isComplete, wordStatusOf, srStatus, type Status } from '../state/status';
import { currentStreak } from '../game/streak';
import useToday from '../hooks/useToday';
import { useDeadlineRefresh } from '../hooks/useCountdown';
import Button from '../components/Button';
import streakSmall from '../assets/streak-small.png';
import { t } from '../i18n';
import {
  yearMonthOf,
  compareYearMonth,
  addMonths,
  clampYearMonth,
  monthGrid,
  isoMonth,
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
// puzzle or after the client's active day are disabled. A WORD cell's status is read from
// the persisted word rounds; a SENTENCE cell's SOURCE IS THE SERVER since #214 removed the
// persisted rounds map — ONE private Query per (month, language), revalidated whenever a
// month becomes the view on screen (#211, `state/history.ts`).
//
// **Loading is EXPLICIT**: a month whose summary has not arrived paints its cells as
// UNKNOWN — dimmed and breathing — never as a full calendar of untouched days, which is a
// claim, and a false one. A month that could not be read says so and offers to ask again;
// there is no local fallback to fall back to.

// `mode` (#156): each daily has its own archive face — a Word mode cell reads its
// status from the word rounds and navigates to /<lang>/word/<date>, so the two dailies'
// histories never blur into one calendar.
export default function Archive({ lang, mode = 'sentence' }: { lang: LangCode; mode?: Mode }) {
  const wordRounds = useGameStore((s) => s.wordRounds);
  const activeDay = useToday();

  // The window of playable days: [FIRST_PUZZLE_DATE, the client's active game day]. Both
  // are ISO labels, so cells compare against them by string order (offset-free).
  const today = useMemo(() => activeDate(new Date()), []);
  const firstMonth = useMemo<YearMonth>(() => yearMonthOf(FIRST_PUZZLE_DATE), []);
  const activeMonth = useMemo<YearMonth>(() => yearMonthOf(today), [today]);

  // The month on screen, clamped into range (start on the current month).
  const [current, setCurrent] = useState<YearMonth>(() =>
    clampYearMonth(activeMonth, firstMonth, activeMonth),
  );

  // The month's summaries and the streak's solved days, both off the ONE private history
  // read (#211). Word mode is deliberately NOT server-backed: #214 kept its clock/outbox
  // local, and a server-backed Word month needs its own product contract — so this asks
  // for nothing at all on that face, and the cells below keep reading `wordRounds`.
  const sentence = mode === 'sentence';
  const history = usePlayerHistory({
    lang,
    mode,
    month: isoMonth(current),
    enabled: sentence,
  });
  // The live streak — displayed HERE (the player-history screen), above the calendar it is
  // derived from (moved from the header, decided 2026-07-21). Hidden at zero, and UNDRAWN
  // (though its box is held, below) until the collection has ARRIVED: a streak counted off
  // an unread history announces a broken chain to someone whose chain is intact.
  const pendingStreak = sentence && history.solvedDays === null;
  const streak = history.solvedDays === null ? 0 : currentStreak(history.solvedDays, activeDay);

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
  // Only visible cells need a wake-up. A live Word run can expire while its archive stays
  // open; without this one-shot refresh, Date.now() would not make that cell turn done.
  useDeadlineRefresh(
    mode === 'word'
      ? cells.map((date) =>
          date === null
            ? null
            : wordRounds[roundKeyForDay(dayNumber(date), lang, 'word')]?.deadline,
        )
      : [],
  );

  return (
    <div className="archive">
      <TopBar
        lang={lang}
        left={<span className="topbar-title">{t(lang, 'archive')}</span>}
        center={
          // The tabs work here too — they switch WHICH daily's calendar this is, which
          // is also what makes Word mode's archive reachable now that the word screens'
          // left slot is the clock: enter the archive from anywhere, tab to the word.
          <ModeTabs lang={lang} mode={mode} onSelect={(m) => navigate(pathForArchive(lang, m))} />
        }
        right={
          <button
            type="button"
            className="home-btn archive-close"
            aria-label={t(lang, 'ariaBackToToday')}
            onClick={() => navigate(pathForMode(lang, mode))}
          >
            <CloseIcon className="ui-icon" aria-hidden />
          </button>
        }
      />

      {/* The streak hero: flame + count above the calendar the streak is made of —
          a stat headline, no label (the flame IS the label). Hidden when zero — and on
          Word mode's archive face, whose runs don't feed the streak (#156, out of
          scope beyond what the round key gives for free).
          Since #211 the collection is a server read, so there is a third state: NOT YET
          KNOWN. It HOLDS THE HERO'S BOX (invisible), because the returning player this
          screen is for almost always has a streak — reserving keeps the calendar still
          for them, where drawing nothing would pull it up and then push it back down on
          every visit. Once the answer lands, a zero streak collapses the box for good. */}
      {mode === 'sentence' && (pendingStreak || streak > 0) && (
        <div
          className={`archive-streak${pendingStreak ? ' archive-streak-pending' : ''}`}
          aria-hidden={pendingStreak || undefined}
        >
          <img src={streakSmall} className="archive-streak-flame" alt="" />
          {!pendingStreak && <span className="sr-only">{t(lang, 'streak')} </span>}
          <span className="archive-streak-count">{pendingStreak ? 0 : streak}</span>
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
            {'‹'}
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
            {'›'}
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
                // A day the month does not name has NO round on the server, which is
                // exactly "not started". A MONTH that has not arrived is a different thing,
                // and `daySummaryStatus` is where the two stop being the same answer.
                status={
                  mode === 'word'
                    ? wordStatusOf(wordRounds[roundKeyForDay(dayNumber(date), lang, 'word')])
                    : daySummaryStatus(history, date)
                }
                longDate={longDate}
              />
            ),
          )}
        </div>

        {/* A month that could not be read says so, under the grid, with the one thing
            that can help — asking again. LOUD like the round's own load failure and for
            the same reason: there is no local history left to quietly fall back to, so a
            silent failure would show a month of blanks as though nothing had been
            played. */}
        {sentence && history.days === null && history.daysPhase === 'failed' && (
          <div className="cal-failed">
            <p className="status error">{t(lang, 'failedHistory')}</p>
            <Button variant="secondary" onClick={history.retry}>
              {t(lang, 'retry')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// One day: a flat key that navigates to that day's game when in range, disabled (dimmed)
// otherwise. A day with any reconstruction (>0%) is FILLED with its heat-ramp color
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
  // OUT OF RANGE has no status at all and never waits for one: a day before the first
  // puzzle or after today could not have been played, so a month still loading must not
  // set the disabled half of the grid breathing.
  const shown: Status = inRange ? status : { kind: 'none' };
  // Reconstruction %: a finished day counts as 100, not-started as 0. Only an in-range
  // day with progress is filled; disabled and 0% days keep the neutral surface + number
  // color. A word run finished by its clock (#163) reads as complete here exactly like a
  // solved sentence — the ripple says "done for the day", not "solved".
  const pct = isComplete(shown) ? 100 : shown.kind === 'progress' ? shown.pct : 0;
  const filled = pct > 0;
  const solved = isComplete(shown);
  // The month's summary has not arrived (#211): the cell keeps its number and its tap —
  // what is missing is what HAPPENED on the day, never whether it can be played — and
  // withholds the one claim it cannot make. It breathes while the read is still out.
  const unknown = shown.kind === 'unknown';
  const className =
    'cal-day' +
    (inRange ? '' : ' cal-day-disabled') +
    (isToday ? ' cal-day-today' : '') +
    (unknown ? ' cal-day-unknown' : '') +
    (unknown && shown.loading ? ' cal-day-waiting' : '') +
    (filled ? ' cal-day-filled' : '') +
    (solved ? ' cal-day-solved' : '');
  return (
    <button
      type="button"
      className={className}
      aria-label={`${longDate.format(dateObj)}${srStatus(lang, shown)}`}
      aria-disabled={!inRange}
      disabled={!inRange}
      onClick={() => inRange && navigate(pathForDay(lang, date, mode))}
      // Only the fill color is dynamic (per-day %); the bg-colored number is static CSS
      // (.cal-day-filled). Neutral days pass no style, so the surface default stands.
      style={filled ? ({ background: progressHeatColor(pct) } as CSSProperties) : undefined}
    >
      {/* A solved day ripples (motion differentiates it from an in-progress day). */}
      {solved && <span className="cal-ripple" aria-hidden="true" />}
      <span className="cal-day-num">{day}</span>
    </button>
  );
}
