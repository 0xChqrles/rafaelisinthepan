import { describe, expect, it } from 'vitest';
import { batchRetryDelayMs, conflictDelayMs, fullJitterDelayMs } from './dynamoRetry';

// CONTRACT: ONE backoff schedule, FULL JITTER over a doubling window (AWS's own
// recommendation for both an unprocessed batch read and a cancelled transaction). Pinned
// once here; the stores assert only that they WAIT between attempts and never before the
// first one.
describe('dynamoRetry', () => {
  it('doubles the CEILING while the wait itself stays random', () => {
    expect([0, 1, 2, 3].map((retry) => batchRetryDelayMs(retry, () => 1))).toEqual([
      50, 100, 200, 400,
    ]);
    // The draw is the whole window, floor included — two Lambdas that were throttled
    // together must be able to come back at different instants.
    expect([0, 1, 2, 3].map((retry) => batchRetryDelayMs(retry, () => 0))).toEqual([0, 0, 0, 0]);
    expect([0, 1, 2, 3].map((retry) => batchRetryDelayMs(retry, () => 0.5))).toEqual([
      25, 50, 100, 200,
    ]);
  });

  it('gives a transaction CONFLICT a shorter window than a throttled batch read', () => {
    // A conflict clears as soon as the rival transaction commits, and the caller is
    // usually holding a player's own request open.
    expect([0, 1, 2, 3].map((retry) => conflictDelayMs(retry, () => 1))).toEqual([20, 40, 80, 160]);
    expect(conflictDelayMs(0, () => 1)).toBeLessThan(batchRetryDelayMs(0, () => 1));
  });

  it('is ONE function underneath, so the two schedules cannot drift apart in shape', () => {
    expect(fullJitterDelayMs(3, 50, () => 1)).toBe(batchRetryDelayMs(3, () => 1));
    expect(fullJitterDelayMs(3, 20, () => 1)).toBe(conflictDelayMs(3, () => 1));
  });
});
