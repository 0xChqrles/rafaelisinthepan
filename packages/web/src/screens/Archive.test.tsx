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
// A settled month holding no round: every in-range day is simply "not started".
vi.mock('../state/history', () => ({
  usePlayerHistory: () => ({ days: new Map(), daysPhase: 'ready', retry: () => {} }),
  daySummaryStatus: () => ({ kind: 'none' }),
}));

import Archive from './Archive';

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
const nextMonth = () => host.querySelectorAll<HTMLButtonElement>('button.cal-arrow')[1];

beforeEach(() => {
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
    // 21:59:30 ET on September 30: September is the last month there is.
    await mountBeforeFlip('2026-10-01');
    expect(day(30).classList.contains('cal-day-today')).toBe(true);
    expect(nextMonth().disabled).toBe(true);

    await crossTheFlip();
    // The month on screen does not jump; the way to October opens.
    expect(day(30).classList.contains('cal-day-today')).toBe(false);
    expect(nextMonth().disabled).toBe(false);
    await act(async () => nextMonth().click());
    expect(day(1).classList.contains('cal-day-today')).toBe(true);
    expect(day(2).disabled).toBe(true);
  });
});
