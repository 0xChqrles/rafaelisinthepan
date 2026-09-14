import { describe, expect, it } from 'vitest';
import { GROUP_ID_PATTERN, generateGroupId, periodRange } from './groups';

// The #271 period ranges — the calendar week (Monday first) and the calendar month, both
// ending on the day the board is addressed by. Asserted against the spec: a board reads
// no day past the one asked about.
describe('periodRange (#271)', () => {
  it('a day is the day itself', () => {
    expect(periodRange('day', '2026-09-13')).toEqual(['2026-09-13']);
  });

  it('a week runs from its Monday to the day asked about', () => {
    // 2026-09-13 is a Sunday: the whole week.
    expect(periodRange('week', '2026-09-13')).toEqual([
      '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13',
    ]);
    // A Monday is a week of one day; a Wednesday, three.
    expect(periodRange('week', '2026-09-07')).toEqual(['2026-09-07']);
    expect(periodRange('week', '2026-09-09')).toEqual(['2026-09-07', '2026-09-08', '2026-09-09']);
  });

  it('a month runs from its first day to the day asked about, across a week boundary', () => {
    expect(periodRange('month', '2026-09-03')).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    expect(periodRange('month', '2026-03-01')).toEqual(['2026-03-01']);
    expect(periodRange('month', '2026-10-31')).toHaveLength(31);
  });
});

describe('group ids', () => {
  it('mint into the player id shape, which is what an invite link carries', () => {
    expect(generateGroupId()).toMatch(GROUP_ID_PATTERN);
    expect(GROUP_ID_PATTERN.test('abcdefghij234567')).toBe(true);
    expect(GROUP_ID_PATTERN.test('ABCDEFGHIJ234567')).toBe(false);
  });
});
