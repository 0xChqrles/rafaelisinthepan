// CONTRACT (issue #61): the publish-buffer coverage report.
// - `upcomingDays(activeDate, n)` counts GAME days = plain calendar dates from the active
//   date (the date iteration is the one subtle part), consistent with the shared day logic.
// - store probing reports existence per (date, lang) via the SAME `storeKey` the readers
//   GET, and the summary is `complete` (exit 0) iff EVERY cell exists — with `firstGap` the
//   earliest missing (date, then lang) cell.
// Asserts the spec, not the implementation. The S3 path reuses `publish`'s already-tested
// stack lookup, so it is left untested here.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { activeDate } from '@whippin/shared';
import { upcomingDays, takeInventory, fsProbe } from './inventory';
import { storeKey } from './layout';

describe('upcomingDays — next N GAME days = calendar dates from the active date', () => {
  it('starts at (and includes) the active date, then N ascending calendar dates', () => {
    expect(upcomingDays('2026-07-07', 3)).toEqual(['2026-07-07', '2026-07-08', '2026-07-09']);
  });

  it('rolls month and year boundaries (plain calendar arithmetic, DST-free)', () => {
    expect(upcomingDays('2026-12-30', 4)).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
    // 2028 is a leap year, so Feb 29 exists in the window.
    expect(upcomingDays('2028-02-28', 3)).toEqual(['2028-02-28', '2028-02-29', '2028-03-01']);
  });

  it('uses the shared active-day definition as the window start', () => {
    const start = activeDate(new Date('2026-06-29T12:00:00Z'));
    expect(upcomingDays(start, 1)).toEqual([start]);
  });

  it('rejects a non-positive count and a malformed start date', () => {
    expect(() => upcomingDays('2026-07-07', 0)).toThrow();
    expect(() => upcomingDays('2026-07-07', 2.5)).toThrow();
    expect(() => upcomingDays('2026-13-40', 3)).toThrow();
  });
});

describe('takeInventory — coverage over a temp filesystem store (mirrors fsStore probing)', () => {
  const DAYS = ['2026-07-07', '2026-07-08', '2026-07-09'];
  const LANGS = ['en', 'fr'];
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'whippin-inventory-'));
    // Fully cover day 0; leave a single (day 1, fr) gap; leave day 2 entirely missing.
    await writeFile(path.join(root, storeKey('2026-07-07', 'en')), '{}');
    await writeFile(path.join(root, storeKey('2026-07-07', 'fr')), '{}');
    await writeFile(path.join(root, storeKey('2026-07-08', 'en')), '{}');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reports each (date, lang) via the shared storeKey and finds the FIRST gap', async () => {
    const s = await takeInventory(DAYS, LANGS, fsProbe(root));
    expect(s.present['2026-07-07']).toEqual({ en: true, fr: true });
    expect(s.present['2026-07-08']).toEqual({ en: true, fr: false });
    expect(s.present['2026-07-09']).toEqual({ en: false, fr: false });
    expect(s.fullyCovered).toBe(1);
    expect(s.total).toBe(3);
    // day 2 is fully missing but LATER; the earliest gap is (day 1, fr).
    expect(s.firstGap).toEqual({ date: '2026-07-08', lang: 'fr' });
    expect(s.complete).toBe(false);
  });

  it('is complete (exit 0) exactly when every (day, lang) exists', async () => {
    const full = await takeInventory(['2026-07-07'], LANGS, fsProbe(root));
    expect(full.complete).toBe(true);
    expect(full.firstGap).toBeNull();
    expect(full.fullyCovered).toBe(1);
  });
});
