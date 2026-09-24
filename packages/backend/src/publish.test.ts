// CONTRACT (issue #4 / #17): publishing a generated puzzle ROUTES it to the store by
// (game day, lang). Asserts the SPEC, not the implementation:
// - the store key is `storeKey(day, lang)` — byte-identical to the key the readers
//   (fsStore/s3Store) GET, so a published puzzle is the one served;
// - the game day defaults to the active 22:00-ET day (`activeDate`), `--day` overrides;
// - the destination is LOCAL by default (no AWS creds), S3 ONLY with `--s3`, which
//   REQUIRES the bucket name (resolved from the deployed stack output, passed in) — never
//   a silent local fallback;
// - an invalid `--day` is rejected.
// The stack-output lookup itself is impure (AWS) and lives outside this pure function.

import { describe, it, expect } from 'vitest';
import { mintBonusId, planPublish } from './publish';
import { activeDate } from '@whippin/shared';
import { sliceKey, storeKey } from './layout';

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

  it('--s3 routes to S3 with the deployed bucket and the SAME key a reader GETs', () => {
    const plan = planPublish({ s3: true, day: '2026-07-01' }, 'fr', NOON_UTC, 'deployed-bucket');
    expect(plan.target).toEqual({ kind: 's3', bucket: 'deployed-bucket' });
    expect(plan.key).toBe(storeKey('2026-07-01', 'fr'));
  });

  it('--s3 with no resolved bucket is rejected (no silent local fallback)', () => {
    expect(() => planPublish({ s3: true }, 'fr', NOON_UTC)).toThrow(/bucket/i);
  });
});

// CONTRACT (#203): a publish also places the derivation slice the round route
// reads. It is part of the same publish rather than a follow-up, because the backend has
// NO fallback — a day whose slice is missing answers the day-addressed 404 — and it is
// keyed exactly like the puzzle so the two describe one daily by construction.
describe('planPublish — the derivation slice beside the puzzle (#203)', () => {
  it('plans a slice, keyed like the readers ask for it', () => {
    const plan = planPublish({ s3: false, day: '2026-07-01' }, 'fr', NOON_UTC);
    expect(plan.slice).toBe(sliceKey('2026-07-01', 'fr'));
    // Same day, same lang — one publish cannot leave the two describing different dailies.
    expect(plan.key).toBe(storeKey('2026-07-01', 'fr'));
  });

  it('carries the slice to S3 too, so a deployed day is never published half-way', () => {
    const plan = planPublish({ s3: true, day: '2026-07-01' }, 'fr', NOON_UTC, 'deployed-bucket');
    expect(plan.target).toEqual({ kind: 's3', bucket: 'deployed-bucket' });
    expect(plan.slice).toBe(sliceKey('2026-07-01', 'fr'));
  });
});

// CONTRACT (bonus puzzles, 2026-09-24): `--bonus` publishes a test puzzle OUTSIDE the
// calendar, keyed by its address `bonus/<id>` through the same key functions the readers
// use; it is exclusive with `--day`, and a minted id is never one the store already holds.
describe('planPublish — a bonus puzzle', () => {
  it('keys the puzzle and its slice by the bonus address, locally and on S3', () => {
    const local = planPublish({ s3: false, bonusId: '1234567' }, 'fr', NOON_UTC);
    expect(local.bonusId).toBe('1234567');
    expect(local.key).toBe('bonus/1234567.fr.json');
    expect(local.slice).toBe('bonus/1234567.fr.slice.json.gz');
    const s3 = planPublish({ s3: true, bonusId: '1234567' }, 'fr', NOON_UTC, 'deployed-bucket');
    expect(s3.target).toEqual({ kind: 's3', bucket: 'deployed-bucket' });
    expect(s3.key).toBe(storeKey('bonus/1234567', 'fr'));
  });

  it('refuses a bonus that is also a day, or a malformed id', () => {
    expect(() => planPublish({ s3: false, day: '2026-07-01', bonusId: '1234567' }, 'fr', NOON_UTC)).toThrow(/exclusive/);
    expect(() => planPublish({ s3: false, bonusId: '0123456' }, 'fr', NOON_UTC)).toThrow();
  });

  it('mints a seven-digit id the store does not hold', async () => {
    const seen: string[] = [];
    const id = await mintBonusId(async (candidate) => {
      seen.push(candidate);
      return seen.length < 3; // the first two draws are taken
    });
    expect(id).toMatch(/^[1-9][0-9]{6}$/);
    expect(seen).toHaveLength(3);
    expect(id).toBe(seen[2]);
    await expect(mintBonusId(async () => true)).rejects.toThrow();
  });
});
