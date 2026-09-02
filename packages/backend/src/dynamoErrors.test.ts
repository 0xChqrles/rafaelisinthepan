import { describe, expect, it } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { classifyTransaction, isConditionFailure, refusedAt } from './dynamoErrors';

// CONTRACT (PR-227 review): what a DynamoDB failure MEANS is decided in ONE place, and the
// exact semantics are pinned HERE. The stores' own suites assert what they DO with each
// verdict; none of them restates the reading.

const cancelled = (...reasons: ({ Code?: string } | undefined)[]) =>
  Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: reasons,
  });

describe('isConditionFailure', () => {
  it('accepts BOTH spellings — the SDK exception and the bare named object', () => {
    expect(
      isConditionFailure(new ConditionalCheckFailedException({ message: 'no', $metadata: {} })),
    ).toBe(true);
    expect(isConditionFailure({ name: 'ConditionalCheckFailedException' })).toBe(true);
  });

  it('is false for everything else, including a cancelled TRANSACTION', () => {
    expect(isConditionFailure(cancelled({ Code: 'ConditionalCheckFailed' }))).toBe(false);
    expect(isConditionFailure(new Error('boom'))).toBe(false);
    expect(isConditionFailure(null)).toBe(false);
    expect(isConditionFailure('ConditionalCheckFailedException')).toBe(false);
  });
});

describe('classifyTransaction', () => {
  it('is not_cancelled for anything that is not a cancellation — the caller rethrows', () => {
    expect(classifyTransaction(new Error('throttled')).kind).toBe('not_cancelled');
    expect(classifyTransaction(null).kind).toBe('not_cancelled');
    expect(classifyTransaction({ CancellationReasons: [{ Code: 'None' }] }).kind).toBe(
      'not_cancelled',
    );
  });

  it('reads a pure business refusal, and says WHICH items refused', () => {
    const verdict = classifyTransaction(
      cancelled({ Code: 'None' }, { Code: 'ConditionalCheckFailed' }, { Code: 'None' }),
    );
    expect(verdict.kind).toBe('refused');
    if (verdict.kind !== 'refused') throw new Error('unreachable');
    expect(refusedAt(verdict.reasons, 1)).toBe(true);
    expect(refusedAt(verdict.reasons, 0)).toBe(false);
    // Past the end is not a refusal.
    expect(refusedAt(verdict.reasons, 9)).toBe(false);
  });

  it('is CONFLICT the moment any item conflicted — retryable, and no condition is read', () => {
    expect(classifyTransaction(cancelled({ Code: 'TransactionConflict' })).kind).toBe('conflict');
  });

  it('lets a CONFLICT win over conditions beside it: a contended attempt answers nothing', () => {
    // The dangerous case. Under a parser that only looked for ConditionalCheckFailed, this
    // would read as "the account changed" — a verdict derived from conditions evaluated
    // while another transaction was mid-write on one of these very rows.
    expect(
      classifyTransaction(
        cancelled({ Code: 'ConditionalCheckFailed' }, { Code: 'TransactionConflict' }),
      ).kind,
    ).toBe('conflict');
  });

  it('is OPERATIONAL for a reason carrying NO code — a missing field is not "None"', () => {
    expect(classifyTransaction(cancelled({ Code: 'ConditionalCheckFailed' }, {})).kind).toBe(
      'operational',
    );
    expect(classifyTransaction(cancelled({ Code: 'ConditionalCheckFailed' }, undefined)).kind).toBe(
      'operational',
    );
  });

  it('is OPERATIONAL for a throttle, a validation error, or a cancellation with no reasons', () => {
    expect(
      classifyTransaction(
        cancelled({ Code: 'ConditionalCheckFailed' }, { Code: 'ThrottlingError' }),
      ).kind,
    ).toBe('operational');
    expect(classifyTransaction(cancelled({ Code: 'ValidationError' })).kind).toBe('operational');
    expect(classifyTransaction(cancelled()).kind).toBe('operational');
    // Every item fine and nothing refused explains nothing, so nothing may be concluded.
    expect(classifyTransaction(cancelled({ Code: 'None' }, { Code: 'None' })).kind).toBe(
      'operational',
    );
  });
});
