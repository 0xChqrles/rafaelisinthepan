// ONE reading of what a DynamoDB write failure MEANS (PR-227 review, 2026-09-02).
//
// Four stores each carried their own spelling of the same two questions — "was this refused
// by its own condition?" and "which items of this transaction were?" — and the spellings had
// drifted apart in ways that matter:
//
//   * two `isConditionFailure` helpers plus three inline `name === '…'` comparisons, only
//     some of which also accepted the SDK's typed exception;
//   * three transaction parsers, all of which mapped `Code` through `?? 'None'`, so a
//     reason DynamoDB sent WITHOUT a code read as "this item was fine" — the one reading a
//     missing field may never have;
//   * none of which knew about `TransactionConflict` at all.
//
// **`TransactionConflict` is the one that was actually dangerous.** AWS cancels a
// transaction whose items are being written by another transaction, reports
// `TransactionConflict` on the conflicting item, and — documented explicitly — the SDKs do
// NOT retry `TransactionCanceledException` on their own (docs: transaction-apis). Under the
// old parsers a conflict simply left `Code` outside the {None, ConditionalCheckFailed} set,
// so the whole error propagated as a 500 on a request that had merely lost a race. Worse,
// a conflict can arrive ALONGSIDE genuine `ConditionalCheckFailed` reasons: reading those as
// a business verdict from an attempt that was contended is reading conditions that may have
// been evaluated against rows another writer was mid-way through. So a conflict is its own
// verdict, it wins over every condition beside it, and the only honest response to it is to
// try again — re-reading first wherever the plan came from a read.
//
// This module classifies. It does not retry, wait, or know what any condition MEANS: each
// store maps `refused` reasons onto its own outcomes, which is the part that is genuinely
// per-store. `dynamoRetry.ts` owns the waiting.
//
// A single-item write racing a transaction fails with `TransactionConflictException`, which
// is a different error and is deliberately NOT classified here — nothing in this backend
// treats one as a business outcome, so it propagates like any other operational failure.

import { ConditionalCheckFailedException, type AttributeValue } from '@aws-sdk/client-dynamodb';

// One per item of the transaction, in the order the items were sent. `Item` is present only
// where the request asked for it (`ReturnValuesOnConditionCheckFailure`).
export interface CancellationReason {
  Code?: string;
  Item?: Record<string, AttributeValue>;
}

// The literal codes this backend reads. Everything else is operational by construction.
const NONE = 'None';
const REFUSED = 'ConditionalCheckFailed';
const CONFLICT = 'TransactionConflict';

export type TransactionVerdict =
  // Not a cancelled transaction at all: the caller has nothing to classify and rethrows.
  | { kind: 'not_cancelled' }
  // At least one item conflicted with another in-flight transaction. RETRYABLE, and no
  // condition in this attempt may be read as a verdict.
  | { kind: 'conflict' }
  // Cancelled carrying a code that is neither `None` nor `ConditionalCheckFailed` — a
  // throttle, a validation error, an item-size refusal, or a reason with NO code at all.
  // Operational: the caller rethrows rather than inventing an outcome for it.
  | { kind: 'operational' }
  // The transaction was refused by its own CONDITIONS and nothing else. `reasons` is the
  // per-item array, so a store can say WHICH of its conditions failed.
  | { kind: 'refused'; reasons: CancellationReason[] };

// A SINGLE-item write refused by its own ConditionExpression. Both spellings, because the
// SDK throws the typed exception while a hand-built test double and a `TransactWriteItems`
// wrapper both surface the plain shape.
export function isConditionFailure(error: unknown): boolean {
  return (
    error instanceof ConditionalCheckFailedException ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'ConditionalCheckFailedException')
  );
}

export function classifyTransaction(error: unknown): TransactionVerdict {
  if (typeof error !== 'object' || error === null) return { kind: 'not_cancelled' };
  const named = error as { name?: unknown; CancellationReasons?: CancellationReason[] };
  if (named.name !== 'TransactionCanceledException') return { kind: 'not_cancelled' };
  const reasons = named.CancellationReasons;
  // A cancellation with no reasons says only that something went wrong. Nothing may be
  // concluded from it, so it is operational.
  if (!reasons || reasons.length === 0) return { kind: 'operational' };
  // CONFLICT FIRST, and unconditionally: a contended attempt's other conditions describe
  // rows another writer was in the middle of, and are not this request's answer.
  if (reasons.some((reason) => reason?.Code === CONFLICT)) return { kind: 'conflict' };
  // Only the LITERAL `None` means "this item was fine". A reason with no `Code` — or no
  // reason at all where the SDK's type promises one — is a shape this backend does not
  // understand, and reading it as success is how an operational failure turns into a
  // confident wrong answer.
  if (!reasons.every((reason) => reason?.Code === NONE || reason?.Code === REFUSED)) {
    return { kind: 'operational' };
  }
  if (!reasons.some((reason) => reason?.Code === REFUSED)) return { kind: 'operational' };
  return { kind: 'refused', reasons };
}

// Was the item at this position the one refused? Reads the code LITERALLY — an index past
// the end, or a reason with no code, is not a refusal.
export function refusedAt(
  reasons: readonly (CancellationReason | undefined)[],
  index: number,
): boolean {
  return reasons[index]?.Code === REFUSED;
}
