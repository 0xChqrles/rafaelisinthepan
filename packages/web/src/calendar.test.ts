// CONTRACT: the archive calendar's pure month arithmetic (calendar.ts). Month navigation
// clamps to the archive's [firstMonth, currentMonth] range, and the grid places each day
// under the right weekday column. Layout visuals are cosmetic (not tested); the math is.

import { describe, it, expect } from 'vitest';
import {
  yearMonthOf,
  compareYearMonth,
  addMonths,
  clampYearMonth,
  daysInMonth,
  monthGrid,
  isoDate,
} from './calendar';

describe('yearMonthOf / isoDate', () => {
  it('reads and rebuilds a year-month', () => {
    expect(yearMonthOf('2026-07-07')).toEqual({ year: 2026, month: 7 });
    expect(isoDate(2026, 7, 7)).toBe('2026-07-07');
    expect(isoDate(2026, 12, 1)).toBe('2026-12-01');
  });
});

describe('compareYearMonth', () => {
  it('orders earlier months first', () => {
    expect(compareYearMonth({ year: 2026, month: 6 }, { year: 2026, month: 7 })).toBeLessThan(0);
    expect(compareYearMonth({ year: 2027, month: 1 }, { year: 2026, month: 12 })).toBeGreaterThan(0);
    expect(compareYearMonth({ year: 2026, month: 7 }, { year: 2026, month: 7 })).toBe(0);
  });
});

describe('addMonths', () => {
  it('adds and subtracts within a year', () => {
    expect(addMonths({ year: 2026, month: 7 }, 1)).toEqual({ year: 2026, month: 8 });
    expect(addMonths({ year: 2026, month: 7 }, -1)).toEqual({ year: 2026, month: 6 });
  });
  it('wraps across year boundaries in both directions', () => {
    expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(addMonths({ year: 2026, month: 3 }, -5)).toEqual({ year: 2025, month: 10 });
  });
});

describe('clampYearMonth', () => {
  const min = { year: 2026, month: 3 };
  const max = { year: 2026, month: 9 };
  it('passes months already inside the range', () => {
    expect(clampYearMonth({ year: 2026, month: 5 }, min, max)).toEqual({ year: 2026, month: 5 });
  });
  it('pulls out-of-range months to the nearest bound', () => {
    expect(clampYearMonth({ year: 2026, month: 1 }, min, max)).toEqual(min);
    expect(clampYearMonth({ year: 2027, month: 2 }, min, max)).toEqual(max);
  });
});

describe('daysInMonth', () => {
  it('counts days, leap February included', () => {
    expect(daysInMonth({ year: 2026, month: 2 })).toBe(28);
    expect(daysInMonth({ year: 2024, month: 2 })).toBe(29); // leap
    expect(daysInMonth({ year: 2026, month: 7 })).toBe(31);
    expect(daysInMonth({ year: 2026, month: 4 })).toBe(30);
  });
});

describe('monthGrid', () => {
  it('leads with weekday pads then one ISO date per day (Sunday-start)', () => {
    // 2026-07-01 is a Wednesday (UTC) -> 3 leading pads for a Sunday-start week.
    const g = monthGrid({ year: 2026, month: 7 }, 0);
    expect(g.slice(0, 4)).toEqual([null, null, null, '2026-07-01']);
    expect(g.filter((c) => c !== null)).toHaveLength(31);
    // Trailing pads fill the grid to a FIXED six weeks (user-decided 2026-08-18): every
    // month stands the same height, so paging never moves the calendar.
    expect(g).toHaveLength(42);
    expect(g[3 + 31 - 1]).toBe('2026-07-31');
    expect(g.slice(3 + 31)).toEqual(Array.from({ length: 42 - 34 }, () => null));
  });
  it('shifts the pad count for a Monday-start week', () => {
    // Wednesday is 2 columns after Monday.
    const g = monthGrid({ year: 2026, month: 7 }, 1);
    expect(g.slice(0, 3)).toEqual([null, null, '2026-07-01']);
  });
  it('has no leading pad when day 1 is the week-start weekday', () => {
    // 2026-11-01 is a Sunday (UTC).
    expect(monthGrid({ year: 2026, month: 11 }, 0)[0]).toBe('2026-11-01');
  });
});
