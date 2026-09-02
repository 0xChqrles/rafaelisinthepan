// How long to wait before asking DynamoDB again — the ONE schedule, for the two things this
// backend retries: a batch read that came back with `UnprocessedKeys`, and a transaction
// cancelled by `TransactionConflict` (`dynamoErrors.ts` says which is which).
//
// FULL JITTER over a doubling window, which is AWS's own recommendation for both. The
// window bounds the wait; the randomness keeps Lambdas that were throttled together — or
// that collided on the same partition — from coming back in lockstep, which is the thing
// that would re-throttle or re-collide. Retrying with NO delay spends the whole budget
// inside a few milliseconds, before any capacity or any rival transaction can clear: that
// is not a retry, it is the same failure four times.
//
// `wait` is INJECTED by every caller that has a test, so asserting a schedule costs no real
// time — the tests read the delays, they never sleep them.

export type Wait = (ms: number) => Promise<void>;

export const sleep: Wait = (ms) => new Promise<void>((done) => setTimeout(done, ms));

export function fullJitterDelayMs(
  retry: number,
  baseMs: number,
  random: () => number = Math.random,
): number {
  return Math.round(random() * baseMs * 2 ** retry);
}

// BATCH READS. Worst case is 5 attempts over well under a second, comfortably inside the
// request's own budget.
export const BATCH_RETRY_ATTEMPTS = 5;
const BATCH_RETRY_BASE_MS = 50;

export function batchRetryDelayMs(retry: number, random: () => number = Math.random): number {
  return fullJitterDelayMs(retry, BATCH_RETRY_BASE_MS, random);
}

// TRANSACTION CONFLICTS. Shorter than a batch read's window: a conflict clears as soon as
// the rival transaction commits, which is milliseconds, and the caller is usually holding a
// player's own request open. Four attempts is a bound, not a promise — a conflict that
// survives it is contention this request cannot win and surfaces as the failure it is.
export const CONFLICT_RETRY_ATTEMPTS = 4;
const CONFLICT_RETRY_BASE_MS = 20;

export function conflictDelayMs(retry: number, random: () => number = Math.random): number {
  return fullJitterDelayMs(retry, CONFLICT_RETRY_BASE_MS, random);
}
