import { describe, expect, it } from 'vitest';
import { memoryScoreStore } from './memoryScoreStore';
import { SCORE_SUBMISSION_LIMIT, type ScoreIncrement, type ScoreKey } from './scoreStore';

const KEY: ScoreKey = { date: '2026-08-13', lang: 'fr', mode: 'sentence' };

function increment(overrides: Partial<ScoreIncrement> = {}): ScoreIncrement {
  return {
    ...KEY,
    ipHash: 'hash-a',
    bucket: 2,
    bucketCount: 4,
    expiresAt: 200_000,
    requestToken: 'request-0',
    ...overrides,
  };
}

describe('memoryScoreStore — local mirror of storage semantics', () => {
  it('increments one bucket and total, while replaying one request idempotently', async () => {
    const store = memoryScoreStore(() => new Date(100_000_000));
    expect(await store.increment(increment())).toBe(true);
    expect(await store.increment(increment())).toBe(true);
    expect(await store.get(KEY, 4)).toEqual({ buckets: [0, 0, 1, 0], total: 1 });
  });

  it('allows five submissions per daily/IP, then atomically rejects without incrementing', async () => {
    const store = memoryScoreStore(() => new Date(100_000_000));
    for (let index = 0; index < SCORE_SUBMISSION_LIMIT; index += 1) {
      expect(await store.increment(increment({ requestToken: `request-${index}` }))).toBe(true);
    }
    expect(await store.increment(increment({ requestToken: 'request-over-cap' }))).toBe(false);
    expect(await store.get(KEY, 4)).toEqual({
      buckets: [0, 0, SCORE_SUBMISSION_LIMIT, 0],
      total: SCORE_SUBMISSION_LIMIT,
    });
  });

  it('isolates the cap by date, language, mode and HMAC hash', async () => {
    const store = memoryScoreStore(() => new Date(100_000_000));
    for (let index = 0; index < SCORE_SUBMISSION_LIMIT; index += 1) {
      await store.increment(increment({ requestToken: `base-${index}` }));
    }
    expect(await store.increment(increment({ ipHash: 'hash-b', requestToken: 'other-ip' }))).toBe(true);
    expect(await store.increment(increment({ mode: 'word', requestToken: 'other-mode' }))).toBe(true);
    expect(await store.get(KEY, 4)).toEqual({
      buckets: [0, 0, SCORE_SUBMISSION_LIMIT + 1, 0],
      total: SCORE_SUBMISSION_LIMIT + 1,
    });
    expect(await store.get({ ...KEY, mode: 'word' }, 4)).toEqual({
      buckets: [0, 0, 1, 0],
      total: 1,
    });
  });

  it('starts a fresh allowance after the 48h dedup item expires', async () => {
    let now = new Date(100_000_000);
    const store = memoryScoreStore(() => now);
    for (let index = 0; index < SCORE_SUBMISSION_LIMIT; index += 1) {
      await store.increment(increment({ expiresAt: 101_000, requestToken: `old-${index}` }));
    }
    now = new Date(102_000_000);
    expect(await store.increment(increment({ expiresAt: 300_000, requestToken: 'fresh' }))).toBe(true);
    expect((await store.get(KEY, 4)).total).toBe(SCORE_SUBMISSION_LIMIT + 1);
  });
});
