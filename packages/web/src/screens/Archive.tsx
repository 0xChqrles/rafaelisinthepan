import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
import { dateForDayNumber } from '@whippin/shared';
import PuzzleTitle from '../components/PuzzleTitle';
import { HeaderLeft } from '../components/TopBar';
import BoardTabs, { tabIds } from '../components/BoardTabs';
import Button from '../components/Button';
// (For its side effect: the dissolve masks the hold's note comes in through.)
import '../components/bayerTiles';
import MonthRaster from '../components/calendar/MonthRaster';
import {
  BLEED,
  CELL_PX,
  HEADROOM,
  HOLD_GAP_PX,
  HOLD_PX,
  NOTE_NARROW_BELOW_PX,
  WEEKDAYS_PX,
  calGeometry,
  type CalGeometry,
} from '../components/calendar/geometry';
import type { KeyState, KeysModel } from '../components/calendar/keysScene';
import { lastMonth, rememberMonth } from '../components/calendar/memory';
import { monthTabs } from '../components/calendar/months';
import useSwipe from '../hooks/useSwipe';
import useToday from '../hooks/useToday';
import { prefersReducedMotion } from '../hooks/useScramble';
import { navigate } from '../routing';
import { pathForDay, type LangCode } from '../langs';
import { FIRST_PUZZLE_DATE } from '../config';
import { daySummaryStatus, usePlayerHistory } from '../state/history';
import { srStatus, type Status } from '../state/status';
import { t } from '../i18n';
import { yearMonthOf, clampYearMonth, monthGrid, isoMonth, type YearMonth } from '../calendar';

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

// A press shows on the key two frames after the finger lands — so a scroll that starts on a
// day never flashes it — and a finger travelling this far is a scroll or a swipe, not a press.
const PRESS_DELAY_MS = 64;
const PRESS_SLOP_PX = 8;
// A swipe past either end of the months answers like an invalid guess: the chip shakes.
const EDGE_SHAKE: Keyframe[] = [
  { translate: '-2px 0', offset: 0, easing: 'steps(1, end)' },
  { translate: '2px 0', offset: 0.25, easing: 'steps(1, end)' },
  { translate: '-2px 0', offset: 0.5, easing: 'steps(1, end)' },
  { translate: '0 0', offset: 0.75 },
  { translate: '0 0', offset: 1 },
];
const EDGE_SHAKE_MS = 160;
// Before the column is measured (the one render before the layout effect, never painted): a
// phone's month for the buttons, and no raster yet.
const FIRST_GEOMETRY = calGeometry(362, 844, true);

// THE ARCHIVE (#55): the player's record, one month at a time, drawn as a month of IRON KEYS
// (`components/calendar/keysScene.ts`) on the bare ground of the board's own column — and each
// day a key that opens that day's game (/<lang>/<date>). Days before the language's first
// puzzle or after the client's active day are disabled. A day's SOURCE IS THE SERVER since
// #214 — ONE private Query per (month, language), revalidated whenever a month becomes the view
// on screen (#211, `state/history.ts`).
//
// THE MONTH is a selection among months, so it turns through the boards' ONE control: the tab
// row (`BoardTabs`), every month from the first to the active one under the white chip —
// which is the clamp — and a sideways swipe on the grid turns it too; a swipe past either end
// shakes the chip. The screen reopens on the month last turned to (this tab's memory), so a
// day played from September comes back to September, where its change plays.
//
// **Loading is EXPLICIT**: a month whose summary has not arrived paints its days as UNKNOWN —
// the key's ghost, never a month of untouched days, which is a claim, and a false one — and a
// month that could not be read says so in the HOLD under the grid, reserved in every state so
// nothing above it moves when it speaks, with the one thing that can help: asking again.
//
// The picture is ONE canvas (`MonthRaster`); the DAYS are real buttons laid over it, each
// tiling its key and half the gaps round it, carrying the date, the status and the tap — a
// screen reader, the keyboard's focus brackets and forced colours all read the buttons.
export default function Archive({ lang }: { lang: LangCode }) {
  // The window of playable days: [the language's first day, the client's active game day].
  // Both are ISO labels, so cells compare against them by string order (offset-free).
  // The day is a LIVE value: a calendar left open across the 22:00-ET flip opens the new
  // day (and, on a month's last night, the new month's tab) without a remount.
  const activeDay = useToday();
  const today = dateForDayNumber(activeDay);
  const firstDate = FIRST_PUZZLE_DATE[lang];
  const firstKey = isoMonth(yearMonthOf(firstDate));
  const activeKey = isoMonth(yearMonthOf(today));
  const tabs = useMemo(
    () => monthTabs(lang, yearMonthOf(firstDate), yearMonthOf(today)),
    // (The months change only when the first or the active month does.)
    [lang, firstKey, activeKey],
  );

  // The month on screen: the one last turned to in this tab today, kept inside the window, else
  // the active month.
  const [current, setCurrent] = useState<YearMonth>(() =>
    clampYearMonth(lastMonth(lang, activeDay) ?? yearMonthOf(today), yearMonthOf(firstDate), yearMonthOf(today)),
  );
  const month = isoMonth(current);
  const shown = Math.max(0, tabs.findIndex((tab) => tab.key === month));

  // The month's summaries (#211).
  //
  // `collection: false` since the STREAK left this screen (user-decided 2026-08-28, for
  // `/account`): the cells read the MONTH, and nothing here reads the solved-day collection
  // any more, so asking for it would spend a consistent GetItem per archive open on an
  // answer nobody renders — the language chooser's own rule.
  const history = usePlayerHistory({ lang, month, collection: false });

  // Locale-owned chrome: the weekday letters (in the locale's week order) and the per-day long
  // date for aria-labels. All UTC so a day's label matches its ISO date exactly.
  const weekStart = useMemo(() => firstDayOfWeek(lang), [lang]);
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
  const inRange = (date: string) => date >= firstDate && date <= today;
  // What each day SAYS: out of the window, nothing — it could not have been played, so a month
  // still loading never sets it waiting; in it, the month's summary. A day the month does not
  // name has NO round on the server, which is exactly "not started"; a MONTH that has not
  // arrived is a different thing, and `daySummaryStatus` is where the two stop being the same
  // answer.
  const shownStatus = (date: string): Status | null => (inRange(date) ? daySummaryStatus(history, date) : null);
  const model = useMemo<KeysModel>(() => {
    const keys = cells.map((date): KeyState => {
      if (date === null) return { kind: 'pad' };
      const day = Number(date.slice(8, 10));
      const status = shownStatus(date);
      if (status === null) return { kind: 'out', day };
      if (status.kind === 'unknown') return { kind: 'unknown', day };
      if (status.kind === 'solved') return { kind: 'solved', day };
      // A % is drawn at most 99: 100 is only ever a solve (`statusOf` rounds 99.6 up).
      if (status.kind === 'progress') return { kind: 'progress', day, pct: Math.min(99, status.pct) };
      return { kind: 'none', day };
    });
    // A month not arrived waits — or, its read failed, rests (`idle` is the one render before
    // the read is asked for, drawn as the wait it is about to be).
    const phase = history.days !== null ? 'data' : history.daysPhase === 'failed' ? 'resting' : 'loading';
    return { keys, today: cells.indexOf(today), phase };
  }, [cells, history.days, history.daysPhase, today, firstDate]);

  // THE ROOM: the column's width (the board's, measured off `.app`'s content box) and the
  // window's height choose the keys' size and the layout (`calGeometry`); a resize re-seats it.
  const rootRef = useRef<HTMLDivElement>(null);
  const [measured, setG] = useState<CalGeometry | null>(null);
  const G = measured ?? FIRST_GEOMETRY;
  useLayoutEffect(() => {
    const parent = rootRef.current?.parentElement;
    if (!parent) return undefined;
    const measure = () => {
      const style = getComputedStyle(parent);
      const room = parent.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0');
      const phone = window.matchMedia?.('(max-width: 640px)').matches ?? window.innerWidth <= 640;
      const next = calGeometry(Math.min(560, Math.floor(room)), window.innerHeight, phone);
      // (A size is its candidate and where the column centres it.)
      setG((was) => (was && was.name === next.name && was.gridX === next.gridX ? was : next));
    };
    measure();
    window.addEventListener('resize', measure);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(parent);
    return () => {
      window.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, []);

  // THE PRESS: a finger held on a day sinks its key (the raster draws it), after two frames.
  const [pressed, setPressed] = useState(-1);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const release = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
    setPressed(-1);
  };
  // (A tap navigates away mid-press: nothing is left to fire.)
  useEffect(
    () => () => {
      if (press.current) window.clearTimeout(press.current.timer);
    },
    [],
  );
  const pressHandlers = (index: number) => ({
    onPointerDown: (e: PointerEvent) => {
      if (!e.isPrimary || e.button !== 0) return;
      release();
      press.current = { timer: window.setTimeout(() => setPressed(index), PRESS_DELAY_MS), x: e.clientX, y: e.clientY };
    },
    onPointerMove: (e: PointerEvent) => {
      const at = press.current;
      if (at && Math.hypot(e.clientX - at.x, e.clientY - at.y) > PRESS_SLOP_PX) release();
    },
    onPointerUp: release,
    onPointerCancel: release,
    onPointerLeave: release,
  });

  // TURNING: the shown month changes at once (the days are the new month's on the same tick);
  // the raster gives way in its own time.
  const turnTo = (index: number) => {
    const tab = tabs[index];
    if (!tab) return;
    const ym = yearMonthOf(`${tab.key}-01`);
    setCurrent(ym);
    rememberMonth(lang, activeDay, ym);
    release();
  };
  const shakeChip = () => {
    if (prefersReducedMotion()) return;
    const ink = rootRef.current?.querySelector<HTMLElement>('.board-tabs-ink');
    ink?.animate?.(EDGE_SHAKE, { duration: EDGE_SHAKE_MS });
  };
  const { handlers: swipe, swiped } = useSwipe((step) => {
    const next = shown + step;
    if (next < 0 || next >= tabs.length) shakeChip();
    else turnTo(next);
  });

  const failed = history.daysPhase === 'failed';
  const holdRef = useRef<HTMLDivElement>(null);
  // RETRY leaves with the note (the read is out again), so the focus it held goes back to the
  // month it asks for, never dropped to the page.
  const retry = () => {
    if (holdRef.current?.contains(document.activeElement)) {
      document.getElementById(tabIds('cal-').tab(month))?.focus();
    }
    history.retry();
  };
  const style = {
    '--bleed': `${BLEED * CELL_PX}px`,
    '--headroom': `${HEADROOM * CELL_PX}px`,
    '--weekdays-h': `${WEEKDAYS_PX}px`,
    '--hold-gap': `${HOLD_GAP_PX}px`,
    '--hold-h': `${HOLD_PX}px`,
    '--grid-w': `${G.gridW}px`,
    '--grid-h': `${G.gridH}px`,
    '--grid-x': `${G.gridX}px`,
    '--key-w': `${G.keyWPx}px`,
    '--key-h': `${G.keyHPx}px`,
    '--col-gap': `${G.colGapPx}px`,
    '--row-gap': `${G.rowGapPx}px`,
    '--air': `${G.airPx}px`,
  } as CSSProperties;

  return (
    <div ref={rootRef} className="archive" data-layout={G.layout} style={style}>
      <HeaderLeft>
        <PuzzleTitle lang={lang} surface="archive" />
      </HeaderLeft>

      {/* WHICH MONTH: the boards' tab row, the month before and after the shown one named for
          the tests. */}
      <div className="cal-head">
        <BoardTabs
          tabs={tabs.map((tab, i) =>
            i === shown - 1 ? { ...tab, attrs: { 'data-cal': 'prev' } } : i === shown + 1 ? { ...tab, attrs: { 'data-cal': 'next' } } : tab,
          )}
          shown={shown}
          idBase="cal-"
          onTurn={turnTo}
          onOpen={() => {}}
        />
      </div>

      <div
        className="cal-body"
        role="tabpanel"
        id={tabIds('cal-').panel}
        aria-labelledby={tabIds('cal-').tab(month)}
        aria-busy={history.daysPhase === 'loading' && history.days === null}
      >
        {/* Weekday letters — decorative (each day carries the full date); today's in the
            plain ink. */}
        <div className="cal-weekdays" aria-hidden="true">
          {weekdayLabels.map((label, i) => (
            <span key={i} className={model.today >= 0 && model.today % 7 === i ? 'on' : undefined}>
              {label}
            </span>
          ))}
        </div>

        <div className="cal-stage" {...swipe}>
          {measured && (
            <MonthRaster
              G={measured}
              lang={lang}
              month={month}
              activeDay={activeDay}
              cells={cells}
              model={model}
              pressed={pressed}
            />
          )}
          <div className="cal-grid">
            {cells.map((date, i) => {
              if (date === null) return <span key={`pad-${i}`} className="cal-pad" aria-hidden="true" />;
              const playable = inRange(date);
              return (
                <button
                  key={date}
                  type="button"
                  className={`cal-day${date === today ? ' cal-day-today' : ''}`}
                  data-cal-day={date}
                  aria-label={`${longDate.format(new Date(`${date}T00:00:00Z`))}${srStatus(lang, shownStatus(date) ?? { kind: 'none' })}`}
                  aria-current={date === today ? 'date' : undefined}
                  disabled={!playable}
                  {...(playable ? pressHandlers(i) : {})}
                  onClick={(e) => {
                    // A swipe's trailing click opens nothing.
                    if (swiped(e) || !playable) return;
                    navigate(pathForDay(lang, date));
                  }}
                >
                  <span className="cal-day-box" data-focus-box>
                    <span className="cal-day-num">{Number(date.slice(8, 10))}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* THE HOLD: a read that could not be had says so, under the grid, with the one thing
          that can help — asking again. LOUD like the round's own load failure and for the same
          reason: there is no local history left to quietly fall back to. **It speaks whether
          or not a month is already drawn** (corrected on review): a REVALIDATION deliberately
          keeps the cached month on screen, so gating it on there being nothing to show meant
          that after one good visit every later failure was silent. What CHANGES with cached
          data is the claim: nothing loaded is a failure to load, in the danger ink; an older
          month still on screen is a note about it, in the plain status ink. Always reserved,
          so nothing above it moves when it speaks — and a LIVE REGION for the same reason,
          mounted before its note, so the note is heard when it comes (and again on a second
          failure). */}
      <div ref={holdRef} className={`cal-hold${G.gridW < NOTE_NARROW_BELOW_PX ? ' narrow' : ''}`} role="status">
        {failed && (
          <div className="cal-hold-in">
            <p className={`cal-note${history.days === null ? ' error' : ''}`}>
              {t(lang, history.days === null ? 'failedHistory' : 'staleHistory')}
            </p>
            <Button variant="secondary" onClick={retry}>
              {t(lang, 'retry')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
