import { describe, expect, it } from 'vitest';
import { nextDeadlineRefreshAt } from './useCountdown';

describe('nextDeadlineRefreshAt — persisted Word status wake-ups', () => {
  const NOW = 1_700_000_000_000;

  it('selects the earliest live deadline and wakes after it becomes done', () => {
    expect(nextDeadlineRefreshAt([NOW + 30_000, NOW + 10_000], NOW)).toBe(NOW + 10_001);
  });

  it('keeps an exact-now deadline pending because done means now > deadline', () => {
    expect(nextDeadlineRefreshAt([NOW], NOW)).toBe(NOW + 1);
  });

  it('ignores past, absent, and non-finite deadlines', () => {
    expect(nextDeadlineRefreshAt([NOW - 1, null, undefined, Number.NaN], NOW)).toBeNull();
  });
});
