// @vitest-environment jsdom
// CONTRACT (root AGENTS.md, Day-addressed routing & the game day): `shared/src/day.ts` is
// the ONE 22:00-ET day definition and the client computes the active day itself. The
// archive's window of playable days ends on that day, so a calendar left open across the
// flip must open the new day — and, on a month's last night, the new month — by itself.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../components/PuzzleTitle', () => ({ default: () => null }));
vi.mock('../components/TopBar', () => ({ HeaderLeft: () => null }));
vi.mock('../routing', () => ({ navigate: vi.fn() }));
// A settled month holding no round — every in-range day is simply "not started" — but for the
// days a test names as OVER (ended unsolved).
const overDays = vi.hoisted(() => new Set<string>());
vi.mock('../state/history', () => ({
  usePlayerHistory: () => ({ days: new Map(), daysPhase: 'ready', retry: () => {} }),
  daySummaryStatus: (_view: unknown, date: string) => (overDays.has(date) ? { kind: 'over' } : { kind: 'none' }),
}));
// The month's picture is a canvas, which jsdom has none of; the days are the screen's buttons.
vi.mock('../components/calendar/MonthRaster', () => ({ default: () => null }));
// The month row: one plain tab per month, the months either side of the shown one marked,
// turning on a click.
vi.mock('../components/BoardTabs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../components/BoardTabs')>();
  return {
    ...real,
    default: (p: { tabs: readonly import('../components/BoardTabs').BoardTabItem[]; shown: number; onTurn: (i: number) => void }) => (
      <div>
        {p.tabs.map((tab, i) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            data-cal={i === p.shown - 1 ? 'prev' : i === p.shown + 1 ? 'next' : undefined}
            onClick={() => p.onTurn(i)}
          >
            {tab.label}
          </button>
        ))}
      </div>
    ),
  };
});

import Archive from './Archive';
import { rememberMonth, resetCalendarMemory } from '../components/calendar/memory';
import { todayDayNumberAt } from '../hooks/useToday';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

// Mounted 30 seconds before the flip: 22:00 in New York is 02:00 UTC while DST holds.
async function mountBeforeFlip(utcDate: string): Promise<void> {
  vi.setSystemTime(new Date(`${utcDate}T01:59:30Z`));
  await act(async () => root.render(<Archive lang="fr" />));
}
async function crossTheFlip(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(60_000);
  });
}
const day = (n: number) =>
  [...host.querySelectorAll<HTMLButtonElement>('button.cal-day')].find((cell) => cell.textContent === String(n))!;
const nextMonth = () => host.querySelector<HTMLButtonElement>('[data-cal="next"]');

beforeEach(() => {
  resetCalendarMemory();
  overDays.clear();
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});

describe('the archive calendar follows the 22:00-ET flip', () => {
  it('the new day becomes playable and takes the today marker while the calendar stays open', async () => {
    // 21:59:30 ET on September 15: the active day is the 15th, the 16th is still ahead.
    await mountBeforeFlip('2026-09-16');
    expect(day(15).classList.contains('cal-day-today')).toBe(true);
    expect(day(16).disabled).toBe(true);

    await crossTheFlip();
    expect(day(16).disabled).toBe(false);
    expect(day(16).classList.contains('cal-day-today')).toBe(true);
    expect(day(15).classList.contains('cal-day-today')).toBe(false);
  });

  it("on a month's last night the new month can be paged to after the flip", async () => {
    // 21:59:30 ET on September 30: September is the last month there is — no month after it.
    await mountBeforeFlip('2026-10-01');
    expect(day(30).classList.contains('cal-day-today')).toBe(true);
    expect(nextMonth()).toBeNull();

    await crossTheFlip();
    // The month on screen does not jump; the way to October opens (its tab now exists).
    expect(day(30).classList.contains('cal-day-today')).toBe(false);
    expect(nextMonth()).not.toBeNull();
    await act(async () => nextMonth()!.click());
    expect(day(1).classList.contains('cal-day-today')).toBe(true);
    expect(day(2).disabled).toBe(true);
  });
});

// The screen reopens on the month last turned to in this tab — the way a day played from
// September comes back to September — kept inside the playable months, and only that day.
describe('the archive reopens on the month last turned to', () => {
  const prevMonth = () => host.querySelector<HTMLButtonElement>('[data-cal="prev"]');
  const remount = async () => {
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(<Archive lang="fr" />));
  };

  it('opens on August again after August was turned to', async () => {
    vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
    await act(async () => root.render(<Archive lang="fr" />));
    expect(nextMonth()).toBeNull();
    await act(async () => prevMonth()!.click());
    await act(async () => prevMonth()!.click());
    expect(prevMonth()).toBeNull();

    await remount();
    // August: the first month (nothing before it), September after it.
    expect(prevMonth()).toBeNull();
    expect(nextMonth()!.textContent).toBe('SEPT');
    expect(day(31).disabled).toBe(false);
  });

  it('keeps it inside the playable months, and forgets it on a new day', async () => {
    vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
    const today = todayDayNumberAt(new Date());
    rememberMonth('fr', today, { year: 2027, month: 1 });
    await act(async () => root.render(<Archive lang="fr" />));
    // Clamped to the active month: October, the last there is.
    expect(nextMonth()).toBeNull();
    expect(prevMonth()!.textContent).toBe('SEPT');

    rememberMonth('fr', today, { year: 2026, month: 8 });
    vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
    await remount();
    expect(nextMonth()).toBeNull();
  });
});

// An over day's key draws the ∞ where its number stands, so its date is said in words — and
// so is what happened: "unsolved", never the silence of a day not started.
describe('an over day is said', () => {
  it('names the long date and "unsolved" in its aria-label', async () => {
    vi.setSystemTime(new Date('2026-09-20T12:00:00Z'));
    overDays.add('2026-09-14');
    await act(async () => root.render(<Archive lang="fr" />));
    expect(day(14).getAttribute('aria-label')).toBe('14 septembre 2026 — non résolu');
    expect(day(14).disabled).toBe(false);
    expect(day(13).getAttribute('aria-label')).toBe('13 septembre 2026');
  });
});
