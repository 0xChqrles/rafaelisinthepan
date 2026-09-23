import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { activeDate, progressHeatColor } from '@whippin/shared';
import PuzzleTitle from '../components/PuzzleTitle';
import { HeaderLeft } from '../components/TopBar';
import { navigate } from '../routing';
import { pathForDay, type LangCode } from '../langs';
import { FIRST_PUZZLE_DATE } from '../config';
import { daySummaryStatus, usePlayerHistory } from '../state/history';
import { srStatus, type Status } from '../state/status';
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
// puzzle or after the client's active day are disabled. A cell's SOURCE IS THE SERVER since
// #214 removed the persisted rounds map — ONE private Query per (month, language),
// revalidated whenever a month becomes the view on screen (#211, `state/history.ts`).
//
// **Loading is EXPLICIT**: a month whose summary has not arrived paints its cells as
// UNKNOWN — dimmed and breathing — never as a full calendar of untouched days, which is a
// claim, and a false one. A month that could not be read says so and offers to ask again;
// there is no local fallback to fall back to.
export default function Archive({ lang }: { lang: LangCode }) {
  // The window of playable days: [FIRST_PUZZLE_DATE, the client's active game day]. Both
  // are ISO labels, so cells compare against them by string order (offset-free).
  const today = useMemo(() => activeDate(new Date()), []);
  const firstMonth = useMemo<YearMonth>(() => yearMonthOf(FIRST_PUZZLE_DATE), []);
  const activeMonth = useMemo<YearMonth>(() => yearMonthOf(today), [today]);

  // The month on screen, clamped into range (start on the current month).
  const [current, setCurrent] = useState<YearMonth>(() =>
    clampYearMonth(activeMonth, firstMonth, activeMonth),
  );

  // The month's summaries (#211).
  //
  // `collection: false` since the STREAK left this screen (user-decided 2026-08-28, for
  // `/account`): the cells read the MONTH, and nothing here reads the solved-day collection
  // any more, so asking for it would spend a consistent GetItem per archive open on an
  // answer nobody renders — the language chooser's own rule.
  const history = usePlayerHistory({ lang, month: isoMonth(current), collection: false });
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
      <HeaderLeft>
        <PuzzleTitle lang={lang} surface="archive" />
      </HeaderLeft>

      {/* The calendar is ONE thing, and it wears the CARD (2026-09-11): the month's
          navigation, its weekdays and its grid inside one panel, the failure note with
          them. */}
      <div className="cal card">
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
                wave={Math.floor(i / 7) + (i % 7)}
                date={date}
                lang={lang}
                inRange={date >= FIRST_PUZZLE_DATE && date <= today}
                isToday={date === today}
                // A day the month does not name has NO round on the server, which is
                // exactly "not started". A MONTH that has not arrived is a different thing,
                // and `daySummaryStatus` is where the two stop being the same answer.
                status={daySummaryStatus(history, date)}
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
        {history.daysPhase === 'failed' && (
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

// The calendar's arrival: the arrive gesture (index.css), one diagonal of days a beat. Only
// where a day comes FROM is named (offset 0): each lands on its own opacity — a dimmed day
// on its dim, a waiting one on its breath — rather than flashing full before settling.
const ARRIVE_FRAMES: Keyframe[] = [{ offset: 0, opacity: 0, translate: '0 10px' }];
const CELL_WAVE_MS = 22;

// One day: a flat key that navigates to that day's game when in range, disabled (dimmed)
// otherwise. A day with any reconstruction (>0%) is FILLED with its heat-ramp color
// (solved = 100%), and its number is drawn in the app background color so it reads on the
// fill; disabled and not-started/0% days stay the neutral surface. A SOLVED day also
// carries the shading ripple — an `ultracode.png` 12-frame sprite animated in CSS
// (.cal-ripple) — so a validated day differs from an in-progress one by MOTION, not only
// color. The aria-label speaks the full date + status.
function DayCell({
  wave,
  date,
  lang,
  inRange,
  isToday,
  status,
  longDate,
}: {
  // The cell's place on the grid's DIAGONAL (row + column), the beat it arrives on.
  wave: number;
  date: string;
  lang: LangCode;
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
  // Reconstruction %: a solved day counts as 100, not-started as 0. Only an in-range day
  // with progress is filled; disabled and 0% days keep the neutral surface + number color.
  const solved = shown.kind === 'solved';
  const pct = solved ? 100 : shown.kind === 'progress' ? shown.pct : 0;
  const filled = pct > 0;
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
  // THE MONTH ARRIVES AS A WAVE: each day rises in on the grid's diagonal, top-left to
  // bottom-right, when it mounts — the screen's first frame, and every page to another
  // month (the days are keyed by date, so a new month is new cells). Played through the
  // Web Animations API rather than a CSS class because a cell's `animation` is already
  // spoken for — a day whose month is still loading BREATHES — and a class-driven arrival
  // would replay the moment the month landed and the breathing stopped.
  const cell = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const node = cell.current;
    if (!node || typeof node.animate !== 'function') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    node.animate(ARRIVE_FRAMES, {
      duration: 260,
      delay: wave * CELL_WAVE_MS,
      easing: 'cubic-bezier(0.2, 1.3, 0.4, 1)',
      fill: 'backwards',
    });
    // Mount only: the wave is the month's arrival, never a re-render's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <button
      ref={cell}
      type="button"
      className={className}
      aria-label={`${longDate.format(dateObj)}${srStatus(lang, shown)}`}
      aria-disabled={!inRange}
      disabled={!inRange}
      onClick={() => inRange && navigate(pathForDay(lang, date))}
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
