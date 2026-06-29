// CONTRACT (issue #4 / #17): publishing a generated puzzle ROUTES it to the store by
// (game day, lang). Asserts the SPEC, not the implementation:
// - the store key is `storeKey(day, lang)` — byte-identical to the key the readers
//   (fsStore/s3Store) GET, so a published puzzle is the one served;
// - the game day defaults to the active 22:00-ET day (`activeDate`), `--day` overrides;
// - the destination is LOCAL by default (no AWS creds), S3 ONLY with `--s3`, which
//   REQUIRES a bucket (flag or PUZZLE_BUCKET) — never a silent local fallback;
// - an invalid `--day` is rejected.

import { describe, it, expect } from 'vitest';
import { planPublish } from './publish';
import { activeDate } from './day';
import { storeKey } from './layout';

// Noon UTC = mid-morning in New York, well before the 22:00-ET active-day reset.
const NOON_UTC = new Date('2026-06-29T12:00:00Z');

describe('planPublish — (day, lang) -> store key + destination', () => {
  it('defaults to LOCAL and the active 22:00-ET day, keyed like the readers', () => {
    const plan = planPublish({ s3: false }, 'fr', NOON_UTC);
    expect(plan.target).toEqual({ kind: 'local' });
    expect(plan.day).toBe(activeDate(NOON_UTC));
    expect(plan.key).toBe(storeKey(activeDate(NOON_UTC), 'fr'));
  });

  it('--day overrides the active day; the key follows the override', () => {
    const plan = planPublish({ s3: false, day: '2026-07-01' }, 'en', NOON_UTC);
    expect(plan.day).toBe('2026-07-01');
    expect(plan.key).toBe('2026-07-01.en.json');
    expect(plan.key).toBe(storeKey('2026-07-01', 'en'));
  });

  it('rejects an invalid --day', () => {
    expect(() => planPublish({ s3: false, day: '2026-13-40' }, 'fr', NOON_UTC)).toThrow();
    expect(() => planPublish({ s3: false, day: 'today' }, 'fr', NOON_UTC)).toThrow();
  });

  it('--s3 routes to S3 with the bucket flag and the SAME key a reader GETs', () => {
    const plan = planPublish(
      { s3: true, bucket: 'my-bucket', day: '2026-07-01' },
      'fr',
      NOON_UTC,
    );
    expect(plan.target).toEqual({ kind: 's3', bucket: 'my-bucket' });
    expect(plan.key).toBe(storeKey('2026-07-01', 'fr'));
  });

  it('--s3 falls back to PUZZLE_BUCKET when no --bucket is given', () => {
    const plan = planPublish({ s3: true }, 'fr', NOON_UTC, 'env-bucket');
    expect(plan.target).toEqual({ kind: 's3', bucket: 'env-bucket' });
  });

  it('--s3 without any bucket is rejected (no silent local fallback)', () => {
    expect(() => planPublish({ s3: true }, 'fr', NOON_UTC)).toThrow(/bucket/i);
  });
});
