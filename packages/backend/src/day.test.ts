// CONTRACT (issue #2): the server is the authoritative time source. The active puzzle
// day flips at 22:00 America/New_York and the conversion MUST be DST-correct (a real
// tz conversion, not a fixed UTC offset). These assert the SPEC, not the implementation.

import { describe, it, expect } from 'vitest';
import {
  zonedParts,
  activeDate,
  dayNumber,
  nextResetAt,
  secondsUntilNextReset,
} from './day';

describe('zonedParts — DST-correct NY wall clock', () => {
  it('summer (EDT, UTC-4): 02:00 UTC reads as 22:00 NY', () => {
    const p = zonedParts(new Date('2026-06-29T02:00:00Z'));
    expect([p.year, p.month, p.day, p.hour]).toEqual([2026, 6, 28, 22]);
  });
  it('winter (EST, UTC-5): 03:00 UTC reads as 22:00 NY', () => {
    const p = zonedParts(new Date('2026-01-16T03:00:00Z'));
    expect([p.year, p.month, p.day, p.hour]).toEqual([2026, 1, 15, 22]);
  });
});

describe('activeDate — flips at 22:00 NY, DST-correct on both sides', () => {
  // Same wall-clock 22:00 boundary, but EDT (UTC-4) in summer vs EST (UTC-5) in winter.
  // A fixed-offset implementation would get exactly one of these wrong.
  it('summer: 21:59 NY stays on the current date', () => {
    // 2026-06-28 21:59 EDT == 2026-06-29 01:59 UTC
    expect(activeDate(new Date('2026-06-29T01:59:00Z'))).toBe('2026-06-28');
  });
  it('summer: 22:00 NY rolls to the next date', () => {
    // 2026-06-28 22:00 EDT == 2026-06-29 02:00 UTC
    expect(activeDate(new Date('2026-06-29T02:00:00Z'))).toBe('2026-06-29');
  });
  it('winter: 21:59 NY stays on the current date', () => {
    // 2026-01-15 21:59 EST == 2026-01-16 02:59 UTC
    expect(activeDate(new Date('2026-01-16T02:59:00Z'))).toBe('2026-01-15');
  });
  it('winter: 22:00 NY rolls to the next date', () => {
    // 2026-01-15 22:00 EST == 2026-01-16 03:00 UTC
    expect(activeDate(new Date('2026-01-16T03:00:00Z'))).toBe('2026-01-16');
  });
  it('a normal daytime instant maps to the same NY calendar date', () => {
    // 2026-06-28 10:00 EDT == 2026-06-28 14:00 UTC
    expect(activeDate(new Date('2026-06-28T14:00:00Z'))).toBe('2026-06-28');
  });
});

describe('dayNumber — monotonic integer id for a date', () => {
  it('counts whole days since the Unix epoch', () => {
    expect(dayNumber('1970-01-01')).toBe(0);
    expect(dayNumber('1970-01-02')).toBe(1);
  });
  it('consecutive dates differ by exactly one', () => {
    expect(dayNumber('2026-06-29') - dayNumber('2026-06-28')).toBe(1);
  });
});

describe('nextResetAt / secondsUntilNextReset — daily flip boundary', () => {
  it('summer, before reset: next flip is today 22:00 EDT', () => {
    const now = new Date('2026-06-28T14:00:00Z'); // 10:00 EDT
    expect(nextResetAt(now).toISOString()).toBe('2026-06-29T02:00:00.000Z');
    expect(secondsUntilNextReset(now)).toBe(12 * 3600);
  });
  it('summer, after reset: next flip is tomorrow 22:00 EDT', () => {
    const now = new Date('2026-06-29T03:00:00Z'); // 2026-06-28 23:00 EDT
    expect(nextResetAt(now).toISOString()).toBe('2026-06-30T02:00:00.000Z');
    expect(secondsUntilNextReset(now)).toBe(23 * 3600);
  });
  it('winter: next flip uses the EST offset (UTC-5), not a frozen summer offset', () => {
    const now = new Date('2026-01-15T12:00:00Z'); // 07:00 EST
    expect(nextResetAt(now).toISOString()).toBe('2026-01-16T03:00:00.000Z');
    expect(secondsUntilNextReset(now)).toBe(15 * 3600);
  });
});
