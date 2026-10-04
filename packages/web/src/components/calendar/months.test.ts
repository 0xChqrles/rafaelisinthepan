import { describe, expect, it } from 'vitest';
import { monthTabs } from './months';

// The month row is the archive's clamp: a tab exists for every month from the language's first
// to the active one, and for no other — so the screen can never page outside its window.

describe('monthTabs — the months in range, as names', () => {
  it('names fr August to October 2026, and en October alone', () => {
    const fr = monthTabs('fr', { year: 2026, month: 8 }, { year: 2026, month: 10 });
    expect(fr.map((tab) => tab.label)).toEqual(['AOÛT', 'SEPT', 'OCT']);
    expect(fr.map((tab) => tab.key)).toEqual(['2026-08', '2026-09', '2026-10']);
    const en = monthTabs('en', { year: 2026, month: 10 }, { year: 2026, month: 10 });
    expect(en.map((tab) => tab.label)).toEqual(['OCT']);
  });

  it('drops the abbreviation dot from every name', () => {
    for (const lang of ['fr', 'en']) {
      const tabs = monthTabs(lang, { year: 2026, month: 1 }, { year: 2026, month: 12 });
      expect(tabs).toHaveLength(12);
      for (const tab of tabs) expect(tab.label.endsWith('.')).toBe(false);
    }
  });

  it('says the year only across two years: on the first tab, each January, and the pinned month', () => {
    const tabs = monthTabs('fr', { year: 2026, month: 11 }, { year: 2027, month: 2 });
    expect(tabs.map((tab) => tab.label)).toEqual(['NOV 2026', 'DÉC', 'JANV 2027', 'FÉVR 2027']);
    const one = monthTabs('fr', { year: 2026, month: 8 }, { year: 2026, month: 12 });
    for (const tab of one) expect(tab.label).not.toMatch(/\d/);
  });

  it('reads each month whole, with its year', () => {
    const fr = monthTabs('fr', { year: 2026, month: 9 }, { year: 2026, month: 9 });
    expect(fr[0].ariaLabel).toBe('septembre 2026');
    const en = monthTabs('en', { year: 2026, month: 10 }, { year: 2026, month: 10 });
    expect(en[0].ariaLabel).toBe('October 2026');
  });

  it('gives one tab for an active month before the first: the first month, pinned', () => {
    const tabs = monthTabs('en', { year: 2026, month: 10 }, { year: 2026, month: 9 });
    expect(tabs.map((tab) => [tab.key, tab.pinned === true])).toEqual([['2026-10', true]]);
  });

  it('pins the active month alone', () => {
    const tabs = monthTabs('fr', { year: 2026, month: 8 }, { year: 2026, month: 10 });
    expect(tabs.map((tab) => tab.pinned === true)).toEqual([false, false, true]);
  });
});
