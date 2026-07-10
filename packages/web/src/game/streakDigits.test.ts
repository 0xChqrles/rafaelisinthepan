import { describe, expect, it } from 'vitest';
import { streakDigitDelays, streakDigitSlots } from './streakDigits';

describe('streakDigitSlots', () => {
  it('marks only the changed place in an ordinary increment', () => {
    expect(streakDigitSlots(12, 13)).toEqual([
      { from: '1', to: '1', changed: false },
      { from: '2', to: '3', changed: true },
    ]);
  });

  it('right-aligns a rollover and treats the new leading digit as impacted', () => {
    expect(streakDigitSlots(9, 10)).toEqual([
      { from: ' ', to: '1', changed: true },
      { from: '9', to: '0', changed: true },
    ]);
  });

  it('animates both existing places when they both change', () => {
    expect(streakDigitSlots(19, 20)).toEqual([
      { from: '1', to: '2', changed: true },
      { from: '9', to: '0', changed: true },
    ]);
  });

  it('represents a restarted streak as 0 -> 1', () => {
    expect(streakDigitSlots(0, 1)).toEqual([{ from: '0', to: '1', changed: true }]);
  });
});

describe('streakDigitDelays', () => {
  it('delays an ordinary single-digit change by one interval', () => {
    expect(streakDigitDelays(streakDigitSlots(12, 13), 90)).toEqual([0, 90]);
  });

  it('staggers a carry from right to left', () => {
    expect(streakDigitDelays(streakDigitSlots(19, 20), 90)).toEqual([180, 90]);
  });

  it('includes a newly added leading digit in the carry', () => {
    expect(streakDigitDelays(streakDigitSlots(99, 100), 90)).toEqual([270, 180, 90]);
  });
});
