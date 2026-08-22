// CONTRACT (issue #17): how a puzzle is keyed in the store. The key is shared by the
// readers (fsStore/s3Store) and the publish writer, so it must match the day/lang
// contract of #2/#6: a FLAT "<date>.<lang>.json" — fully determined by (game day,
// language), GetObject-addressable, ListObjects-listable by date prefix. Asserts the
// spec, not the implementation.

import { describe, it, expect } from 'vitest';
import { isValidDate, sliceKey, storeKey } from './layout';

describe('storeKey — flat "<date>.<lang>.json"', () => {
  it('joins the game day and lang, no folder, no words', () => {
    expect(storeKey('2026-06-29', 'fr')).toBe('2026-06-29.fr.json');
  });

  it('is one deterministic key per (date, lang)', () => {
    expect(storeKey('2026-06-29', 'fr')).toBe(storeKey('2026-06-29', 'fr'));
    expect(storeKey('2026-06-29', 'en')).not.toBe(storeKey('2026-06-29', 'fr'));
  });

  it('shares a date PREFIX so a month/year is listable (ListObjects)', () => {
    // Both langs of a day, and every day of a month, share the "<year>-<month>" prefix.
    expect(storeKey('2026-06-29', 'fr').startsWith('2026-06')).toBe(true);
    expect(storeKey('2026-06-01', 'en').startsWith('2026-06')).toBe(true);
    expect(storeKey('2026-06-29', 'fr').startsWith('2026')).toBe(true);
  });
});

// CONTRACT (#203): the derivation slice sits BESIDE the puzzle, in the same flat layout,
// and its key says it is gzip — the object IS compressed bytes, so a reader that decodes
// it as text hands JSON.parse a mangled blob.
describe('sliceKey — the derivation slice, beside the sentence puzzle', () => {
  it('is one deterministic key per (date, lang), distinct from the puzzle\'s', () => {
    expect(sliceKey('2026-06-29', 'fr')).toBe('2026-06-29.fr.slice.json.gz');
    expect(sliceKey('2026-06-29', 'fr')).not.toBe(storeKey('2026-06-29', 'fr'));
    expect(sliceKey('2026-06-29', 'en')).not.toBe(sliceKey('2026-06-29', 'fr'));
  });

  it('shares the same date PREFIX, so a day still lists as one unit', () => {
    expect(sliceKey('2026-06-29', 'fr').startsWith('2026-06')).toBe(true);
  });
});

describe('isValidDate — strict real-calendar YYYY-MM-DD', () => {
  it('accepts a real date', () => {
    expect(isValidDate('2026-06-29')).toBe(true);
  });
  it('rejects malformed / impossible dates', () => {
    for (const bad of ['2026-6-9', '2026/06/29', '2026-13-01', '2026-02-30', 'today', '']) {
      expect(isValidDate(bad)).toBe(false);
    }
  });
});
