import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { activeDate, dayNumber, progressHeatColor } from '@whippin/shared';
import TopBar from '../components/TopBar';
import PuzzleTitle from '../components/PuzzleTitle';
import HeaderKeys from '../components/HeaderKeys';
import { navigate } from '../routing';
import { pathForMode, pathForDay, pathForArchive, type LangCode, type Mode } from '../langs';
import { FIRST_PUZZLE_DATE } from '../config';
import { useGameStore, roundKeyForDay } from '../state/gameStore';
import { daySummaryStatus, usePlayerHistory } from '../state/history';
import { isComplete, wordStatusOf, srStatus, type Status } from '../state/status';
import { useDeadlineRefresh } from '../hooks/useCountdown';
import Button from '../components/Button';
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

  // The window of playable days: [FIRST_PUZZLE_DATE, the client's active game day]. Both
  // are ISO labels, so cells compare against them by string order (offset-free).
  const today = useMemo(() => activeDate(new Date()), []);
  const firstMonth = useMemo<YearMonth>(() => yearMonthOf(FIRST_PUZZLE_DATE), []);
  const activeMonth = useMemo<YearMonth>(() => yearMonthOf(today), [today]);

  // The month on screen, clamped into range (start on the current month).
  const [current, setCurrent] = useState<YearMonth>(() =>
    clampYearMonth(activeMonth, firstMonth, activeMonth),
  );

  // The month's summaries (#211). Word mode is deliberately NOT server-backed: #214 kept
  // its clock/outbox local, and a server-backed Word month needs its own product contract —
  // so this asks for nothing at all on that face, and the cells below keep reading
  // `wordRounds`.
  //
  // `collection: false` since the STREAK left this screen (user-decided 2026-08-28, for
  // `/account`): the cells read the MONTH, and nothing here reads the solved-day collection
  // any more, so asking for it would spend a consistent GetItem per archive open on an
  // answer nobody renders — the language chooser's own rule.
  const sentence = mode === 'sentence';
  const history = usePlayerHistory({
    lang,
    mode,
    month: isoMonth(current),
    enabled: sentence,
    collection: false,
  });
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
        left={<PuzzleTitle lang={lang} mode={mode} onArchive />}
        right={<HeaderKeys lang={lang} mode={mode} on="archive" />}
      />

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

        {/* A read that could not be had says so, under the grid, with the one thing that
            can help — asking again. LOUD like the round's own load failure and for the same
            reason: there is no local history left to quietly fall back to.
            **It speaks whether or not a month is already drawn** (corrected on review): a
            REVALIDATION deliberately keeps the cached month on screen, so gating the block
            on there being nothing to show meant that after one good visit every later
            failure was silent — an offline player reading a stale calendar as the truth.
            What CHANGES with cached data is the claim, not the presence: nothing loaded is a
            failure to load, where an older answer still on screen is a failure to REFRESH,
            and saying the first over a filled calendar would be plainly false. */}
        {sentence && history.daysPhase === 'failed' && (
          <div className="cal-failed">
            {/* Nothing to show is a FAILURE and wears the danger ink; an older month still
                on screen is a NOTE about it, so it takes the plain status ink rather than
                painting a working calendar red. */}
            <p className={history.days === null ? 'status error' : 'status'}>
              {t(lang, history.days === null ? 'failedHistory' : 'staleHistory')}
            </p>
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
