// Pure month-grid helpers for the archive calendar (#55). All date math is UTC so a day
// cell's ISO label is offset-free and compares directly (string order) against the ISO
// range bounds — no timezone drift near midnight. The screen owns rendering; this owns
// the arithmetic (month navigation clamp + the laid-out grid), so it can be unit-tested.

// A year + 1-based month (1 = January … 12 = December).
export interface YearMonth {
  year: number;
  month: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

// The ISO "YYYY-MM-DD" label for a UTC (year, month, day).
export function isoDate(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

// The year-month a "YYYY-MM-DD" belongs to.
export function yearMonthOf(date: string): YearMonth {
  const [year, month] = date.split('-').map(Number);
  return { year, month };
}

// -1 / 0 / 1 ordering of two year-months (earlier first).
export function compareYearMonth(a: YearMonth, b: YearMonth): number {
  return a.year !== b.year ? a.year - b.year : a.month - b.month;
}

// A year-month shifted by `delta` months (negative = earlier), normalized. Uses a
// floored modulo so negative shifts wrap the month correctly.
export function addMonths({ year, month }: YearMonth, delta: number): YearMonth {
  const zero = year * 12 + (month - 1) + delta; // months since year 0
  return { year: Math.floor(zero / 12), month: ((zero % 12) + 12) % 12 + 1 };
}

// Clamp a year-month into the inclusive [min, max] window.
export function clampYearMonth(ym: YearMonth, min: YearMonth, max: YearMonth): YearMonth {
  if (compareYearMonth(ym, min) < 0) return min;
  if (compareYearMonth(ym, max) > 0) return max;
  return ym;
}

// Number of days in a UTC month (day 0 of the next month == last day of this one).
export function daysInMonth({ year, month }: YearMonth): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// The weekday (0 = Sunday … 6 = Saturday) of the month's first day, UTC.
function firstWeekday({ year, month }: YearMonth): number {
  return new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
}

// The month laid out for a 7-column grid whose weeks start on `weekStart` (0 = Sunday,
// 1 = Monday, …): a flat array with `null` leading pads so day 1 falls under its weekday
// column, then one ISO date string per day. Trailing pads are unnecessary (the grid just
// ends). Locale decides `weekStart`; the caller supplies it.
export function monthGrid(ym: YearMonth, weekStart: number): (string | null)[] {
  const lead = (firstWeekday(ym) - weekStart + 7) % 7;
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let day = 1; day <= daysInMonth(ym); day += 1) {
    cells.push(isoDate(ym.year, ym.month, day));
  }
  return cells;
}
