import { describe, expect, it } from 'vitest';
import { dayNumber } from '@whippin/shared';
import { millisecondsUntilTodayRefresh, todayDayNumberAt } from './useToday';

describe('useToday scheduling — the 22:00 ET game-day boundary', () => {
  it('switches at 22:00 during daylight-saving time', () => {
    const before = new Date('2026-07-11T01:59:59.000Z'); // Jul 10, 21:59:59 EDT
    const atReset = new Date('2026-07-11T02:00:00.000Z'); // Jul 10, 22:00:00 EDT

    expect(todayDayNumberAt(before)).toBe(dayNumber('2026-07-10'));
    expect(todayDayNumberAt(atReset)).toBe(dayNumber('2026-07-11'));
    expect(millisecondsUntilTodayRefresh(before)).toBe(1_001);
  });

  it('switches at the later UTC instant during standard time', () => {
    const before = new Date('2026-01-11T02:59:59.000Z'); // Jan 10, 21:59:59 EST
    const atReset = new Date('2026-01-11T03:00:00.000Z'); // Jan 10, 22:00:00 EST

    expect(todayDayNumberAt(before)).toBe(dayNumber('2026-01-10'));
    expect(todayDayNumberAt(atReset)).toBe(dayNumber('2026-01-11'));
    expect(millisecondsUntilTodayRefresh(before)).toBe(1_001);
  });
});
