import { describe, expect, it, vi } from 'vitest';
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { LINK_CODE_MAX_ATTEMPTS } from '@whippin/shared';
import { expectExpressionsValid, expectTransactItemValid } from './dynamoExpressionChecks';
import { dynamoLinkStore } from './dynamoLinkStore';
import { emailHash as emailHashOf } from './linkStore';

// CONTRACT (#204), and it is the round store's contract restated for a second write path:
// DynamoDB rejects an ExpressionAttributeNames/Values entry no expression references, and an
// alias no entry declares, with a ValidationException BEFORE anything is written — and its
// CONDITION grammar has no arithmetic and exactly six functions. A mocked client validates
// neither, so a command that would fail every production call looks perfectly fine here
// unless the SHAPE of the expression is what the suite holds. This file's writes are the
// ones nothing local can exercise: an account is DELETED by them.

// Every store here is built over this, so no write in this file escapes the checks. The
// `wait` is INJECTED (`waits` records the schedule), so the conflict backoff is asserted
// without a test ever sleeping.
function makeStore(send: (command: unknown) => Promise<unknown>) {
  const checked = vi.fn(async (command: unknown) => {
    if (command instanceof UpdateItemCommand) expectExpressionsValid(command.input);
    if (command instanceof TransactWriteItemsCommand) {
      for (const item of command.input.TransactItems ?? []) expectTransactItemValid(item);
    }
    return send(command);
  });
  const waits: number[] = [];
  return {
    store: dynamoLinkStore({ send: checked } as unknown as DynamoDBClient, 'scores', {
      wait: async (ms) => {
        waits.push(ms);
      },
    }),
    send: checked,
    waits,
  };
}

// A cancellation naming a code per item, in the order the items were sent. `undefined`
// stands for a reason the service sent with NO code at all.
const cancelling = (...codes: (string | undefined)[]) =>
  Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => (Code === undefined ? {} : { Code })),
  });

const HASH = 'a'.repeat(64);
const NOW = new Date('2026-08-26T12:00:00.000Z');

// CONTRACT: the allowances are ROLLING windows — "5 per address per hour" means the last
// hour, whatever the clock reads — and they are spent together or not at all.
describe('dynamoLinkStore — the send allowance', () => {
  const HOUR = 3_600;
  const stored = (...at: number[]) => ({
    Item: { sends: { L: at.map((ms) => ({ N: String(ms) })) } },
  });

  it('refuses a zero allowance without creating a first counter item', async () => {
    const { store, send } = makeStore(async () => ({}));
    await expect(
      store.spendSends([{ scope: 'addr', hash: HASH, limit: 0 }], HOUR, NOW),
    ).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('writes every scope in ONE transaction, each conditioned on the exact list it read', async () => {
    const { store, send } = makeStore(async (command) => {
      if (command instanceof GetItemCommand) {
        return command.input.Key!.pk.S === `linksend#addr#${HASH}`
          ? stored(NOW.getTime() - 10_000)
          : {};
      }
      return {};
    });
    await expect(
      store.spendSends(
        [
          { scope: 'addr', hash: HASH, limit: 5 },
          { scope: 'ip', hash: 'b'.repeat(64), limit: 20 },
        ],
        HOUR,
        NOW,
      ),
    ).resolves.toBe(true);

    const command = send.mock.calls.map(([c]) => c).find((c) => c instanceof TransactWriteItemsCommand) as TransactWriteItemsCommand;
    const items = command.input.TransactItems!;
    expect(items).toHaveLength(2);
    // The key names the scope and the hash ONLY — no clock bucket.
    expect(items[0].Put!.Item!.pk.S).toBe(`linksend#addr#${HASH}`);
    // An existing list is replaced only if it is still the one that was read…
    expect(items[0].Put!.ConditionExpression).toBe('#sends = :observed');
    expect(items[0].Put!.ExpressionAttributeValues![':observed']).toEqual({
      L: [{ N: String(NOW.getTime() - 10_000) }],
    });
    expect(items[0].Put!.Item!.sends.L).toHaveLength(2);
    // …and a scope with no item yet is created, not overwritten.
    expect(items[1].Put!.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(items[1].Put!.Item!.sends.L).toEqual([{ N: String(NOW.getTime()) }]);
  });

  it('counts only the sends inside the ROLLING window, and prunes the rest on the write', async () => {
    const recent = Array.from({ length: 4 }, (_, i) => NOW.getTime() - (i + 1) * 60_000);
    const old = NOW.getTime() - HOUR * 1_000 - 1;
    const { store, send } = makeStore(async (command) =>
      command instanceof GetItemCommand ? stored(old, ...recent) : {},
    );
    // Five stored, one of them an hour and a millisecond old: four count, so the fifth send
    // of the hour is allowed…
    await expect(
      store.spendSends([{ scope: 'addr', hash: HASH, limit: 5 }], HOUR, NOW),
    ).resolves.toBe(true);
    const written = (send.mock.calls.map(([c]) => c).find((c) => c instanceof TransactWriteItemsCommand) as TransactWriteItemsCommand)
      .input.TransactItems![0].Put!;
    // …the condition still names the WHOLE stored list, and the item written back holds only
    // what still counts plus this send.
    expect(written.ExpressionAttributeValues![':observed'].L).toHaveLength(5);
    expect(written.Item!.sends.L!.map((v) => Number(v.N))).toEqual([...recent, NOW.getTime()]);

    // …and five inside the hour refuse, with no write at all.
    const full = makeStore(async (command) =>
      command instanceof GetItemCommand ? stored(NOW.getTime() - 3_599_000, ...recent) : {},
    );
    await expect(
      full.store.spendSends([{ scope: 'addr', hash: HASH, limit: 5 }], HOUR, NOW),
    ).resolves.toBe(false);
    expect(full.send.mock.calls.some(([c]) => c instanceof TransactWriteItemsCommand)).toBe(false);
  });

  it('decides again from what NOW stands when a concurrent send changed a list', async () => {
    let writes = 0;
    const { store, send } = makeStore(async (command) => {
      if (command instanceof GetItemCommand) {
        // The second read sees the send that beat this one to the row.
        return writes === 0 ? {} : stored(NOW.getTime() - 1);
      }
      writes += 1;
      if (writes === 1) {
        throw Object.assign(new Error('cancelled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
        });
      }
      return {};
    });
    await expect(
      store.spendSends(
        [
          { scope: 'addr', hash: HASH, limit: 5 },
          { scope: 'ip', hash: HASH, limit: 20 },
        ],
        HOUR,
        NOW,
      ),
    ).resolves.toBe(true);
    const retried = send.mock.calls
      .map(([c]) => c)
      .filter((c): c is TransactWriteItemsCommand => c instanceof TransactWriteItemsCommand);
    expect(retried).toHaveLength(2);
    // The retry counts the send it lost to: two instants on the row now.
    expect(retried[1].input.TransactItems![0].Put!.Item!.sends.L).toHaveLength(2);

    // A list ALREADY at its bound after the concurrent send is a refusal, not a retry loop.
    const beaten = makeStore(async (command) => {
      if (command instanceof GetItemCommand) {
        return stored(...Array.from({ length: 5 }, (_, i) => NOW.getTime() - i));
      }
      throw new Error('must not write');
    });
    await expect(
      beaten.store.spendSends([{ scope: 'addr', hash: HASH, limit: 5 }], HOUR, NOW),
    ).resolves.toBe(false);
  });
});

describe('dynamoLinkStore — verifying a code', () => {
  it('counts an attempt only when the code is WRONG, by making that the CONDITION', async () => {
    const { store, send } = makeStore(async () => ({ Attributes: { attempts: { N: '2' } } }));
    await expect(store.verify(HASH, 'b'.repeat(64), NOW)).resolves.toEqual({
      outcome: 'wrong',
      attemptsLeft: LINK_CODE_MAX_ATTEMPTS - 2,
    });

    const command = send.mock.calls[0][0] as UpdateItemCommand;
    // A correct code fails this condition and spends nothing — which one successful link
    // needs, since the erase confirmation makes it verify twice.
    expect(command.input.ConditionExpression).toContain('#codeHash <> :codeHash');
    expect(command.input.ConditionExpression).toContain('#attempts < :max');
    expect(command.input.ConditionExpression).toContain('#expiresAt > :now');
  });

  it('classifies the refused write by ONE consistent read: ok / spent / expired / none', async () => {
    const refuse = () => {
      throw new ConditionalCheckFailedException({ $metadata: {}, message: 'nope' });
    };
    const submitted = 'c'.repeat(64);
    const cases: [Record<string, AttributeValue> | undefined, string][] = [
      [
        { attempts: { N: '1' }, expiresAt: { N: '9999999999' }, codeHash: { S: submitted } },
        'ok',
      ],
      [{ attempts: { N: String(LINK_CODE_MAX_ATTEMPTS) }, expiresAt: { N: '9999999999' } }, 'spent'],
      [{ attempts: { N: '0' }, expiresAt: { N: '1' } }, 'expired'],
      [undefined, 'none'],
    ];
    for (const [item, outcome] of cases) {
      const { store, send } = makeStore(async (command) => {
        if (command instanceof GetItemCommand) return item ? { Item: item } : {};
        return refuse();
      });
      await expect(store.verify(HASH, submitted, NOW)).resolves.toMatchObject({ outcome });
      // Strongly consistent: it classifies a refusal this very request produced.
      const read = send.mock.calls
        .map(([command]) => command)
        .find((command): command is GetItemCommand => command instanceof GetItemCommand);
      expect(read!.input.ConsistentRead).toBe(true);
    }
  });

  // THE FIFTH WRONG CODE IS STILL A WRONG CODE (PR-227 review). A COUNTED mismatch is
  // `wrong` — the last one included, with nothing left — and `spent` is what the NEXT call
  // gets. Calling the fifth one `spent` answered 409 for a code the player actually typed
  // wrong, and made the screen's "too many wrong codes" copy unreachable.
  it('answers the LAST counted mismatch `wrong` with nothing left, and the NEXT one `spent`', async () => {
    const submitted = 'c'.repeat(64);
    // The write that counted the fifth attempt SUCCEEDS — the condition is `< :max` and
    // the stored count was 4 — and returns the new total.
    const fifth = makeStore(async () => ({
      Attributes: { attempts: { N: String(LINK_CODE_MAX_ATTEMPTS) } },
    }));
    await expect(fifth.store.verify(HASH, submitted, NOW)).resolves.toEqual({
      outcome: 'wrong',
      attemptsLeft: 0,
    });

    // The sixth: the condition refuses it, and the classification read says the challenge
    // no longer accepts an attempt.
    const sixth = makeStore(async (command) => {
      if (command instanceof GetItemCommand) {
        return {
          Item: {
            attempts: { N: String(LINK_CODE_MAX_ATTEMPTS) },
            expiresAt: { N: '9999999999' },
            codeHash: { S: 'd'.repeat(64) },
          },
        };
      }
      throw new ConditionalCheckFailedException({ $metadata: {}, message: 'spent' });
    });
    await expect(sixth.store.verify(HASH, submitted, NOW)).resolves.toEqual({
      outcome: 'spent',
      attemptsLeft: 0,
    });
  });

  it('retries a refusal against a replacement challenge instead of calling any fresh row ok', async () => {
    let updates = 0;
    const { store } = makeStore(async (command) => {
      if (command instanceof UpdateItemCommand) {
        updates += 1;
        if (updates === 1) {
          throw new ConditionalCheckFailedException({ $metadata: {}, message: 'replaced' });
        }
        return { Attributes: { attempts: { N: '1' } } };
      }
      if (command instanceof GetItemCommand) {
        return {
          Item: {
            attempts: { N: '0' },
            expiresAt: { N: '9999999999' },
            codeHash: { S: 'd'.repeat(64) },
          },
        };
      }
      return {};
    });

    await expect(store.verify(HASH, 'c'.repeat(64), NOW)).resolves.toEqual({
      outcome: 'wrong',
      attemptsLeft: LINK_CODE_MAX_ATTEMPTS - 1,
    });
    expect(updates).toBe(2);
  });
});

describe('dynamoLinkStore — binding one address', () => {
  const input = {
    emailHash: 'e'.repeat(64),
    codeHash: 'c'.repeat(64),
    email: 'zoe@example.com',
    accountId: 'aaaaaaaaaaaaaaaa',
    now: NOW.toISOString(),
  };

  it('conditions the account slot and consumes the exact verified challenge', async () => {
    const { store, send } = makeStore(async () => ({}));
    await expect(store.bind(input)).resolves.toBe('bound');
    const command = send.mock.calls[0][0] as TransactWriteItemsCommand;
    const items = command.input.TransactItems!;
    expect(items[1].Update!.ConditionExpression).toContain('attribute_not_exists(#email)');
    expect(items[2].Delete!.ConditionExpression).toContain('#codeHash = :codeHash');
    expect(command.input.ClientRequestToken).toHaveLength(36);

    await store.bind({ ...input, email: 'zoe+changed@example.com' });
    const changed = send.mock.calls[1][0] as TransactWriteItemsCommand;
    expect(changed.input.ClientRequestToken).not.toBe(command.input.ClientRequestToken);
  });

  it('classifies transaction conditions by item instead of throwing a 500', async () => {
    for (const [index, outcome] of [
      [0, 'taken'],
      [1, 'account_changed'],
      [2, 'challenge_changed'],
    ] as const) {
      const { store } = makeStore(async () => {
        throw Object.assign(new Error('cancelled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [0, 1, 2].map((at) => ({
            Code: at === index ? 'ConditionalCheckFailed' : 'None',
          })),
        });
      });
      await expect(store.bind(input)).resolves.toBe(outcome);
    }
  });

  it('lets the CHALLENGE win when more than one condition failed', async () => {
    // A binding that won may have consumed the challenge: the losing request must read
    // that, not `taken` or `account_changed`, or one code reads as two final answers.
    for (const indices of [[0, 2], [1, 2], [0, 1, 2]]) {
      const { store } = makeStore(async () => {
        throw cancelling(
          ...[0, 1, 2].map((at) => (indices.includes(at) ? 'ConditionalCheckFailed' : 'None')),
        );
      });
      await expect(store.bind(input)).resolves.toBe('challenge_changed');
    }
  });
});

describe('dynamoLinkStore — the indivisible core', () => {
  const PLAN = {
    tokenHash: HASH,
    deviceId: 'dddddddddddddddd',
    from: 'bbbbbbbbbbbbbbbb',
    to: 'aaaaaaaaaaaaaaaa',
    emailHash: 'e'.repeat(64),
    codeHash: 'c'.repeat(64),
    now: NOW.toISOString(),
  };

  it('moves the ONE device item and consumes the challenge — and nothing else when the account SURVIVES', async () => {
    const { store, send } = makeStore(async () => ({}));
    await store.adopt({ ...PLAN, erase: false });

    const items = (send.mock.calls[0][0] as TransactWriteItemsCommand).input.TransactItems!;
    expect(items).toHaveLength(4);
    // The base key is the TOKEN's hash and does not change; only the account it names and
    // the index key the sign-out screen reads it by.
    expect(items[0].Update!.Key!.pk.S).toBe(`device#${HASH}`);
    expect(items[0].Update!.ConditionExpression).toBe(
      '#accountId = :from AND #deviceId = :deviceId',
    );
    expect(items[0].Update!.ExpressionAttributeValues![':index'].S).toBe(`player#${PLAN.to}`);
    expect(items[1].ConditionCheck!.Key!.pk.S).toBe(`player#${PLAN.to}`);
    expect(items[2].Delete!.Key!.pk.S).toBe(`link#${PLAN.emailHash}`);
    expect(items[2].Delete!.ConditionExpression).toContain('#codeHash = :codeHash');
    expect(items[3].ConditionCheck!.ConditionExpression).toContain('attribute_exists(#email)');

    await store.adopt({ ...PLAN, deviceId: 'eeeeeeeeeeeeeeee', erase: false });
    const changed = send.mock.calls[1][0] as TransactWriteItemsCommand;
    expect(changed.input.ClientRequestToken).not.toBe(
      (send.mock.calls[0][0] as TransactWriteItemsCommand).input.ClientRequestToken,
    );
  });

  it('deletes the account row AND its profile row together when it is being erased — and queues its PURGE', async () => {
    const { store, send } = makeStore(async () => ({}));
    await store.adopt({ ...PLAN, erase: true, departFrom: PLAN.from });

    const items = (send.mock.calls[0][0] as TransactWriteItemsCommand).input.TransactItems!;
    const deleted = items.flatMap((item) => (item.Delete ? [item.Delete.Key!.pk.S] : []));
    // The profile row too: an identity-bearing read resolves a face through it, so leaving
    // it behind would keep exposing an account the player has left for good.
    expect(deleted).toContain(`player#${PLAN.from}`);
    expect(deleted.filter((pk) => pk === `player#${PLAN.from}`)).toHaveLength(2);
    // The departure job (#271) is persisted in the SAME transaction that deletes the
    // account, which is what makes the fan-out behind it durable.
    const job = items.find((item) => item.Put?.Item?.pk.S === `depart#${PLAN.to}`);
    expect(job!.Put!.Item!.sk.S).toBe(`from#${PLAN.from}`);
    const source = items.find(
      (item) => item.Delete?.Key?.pk.S === `player#${PLAN.from}` && item.Delete.Key.sk.S === 'account',
    );
    expect(source!.Delete!.ConditionExpression).toContain('attribute_not_exists(#email)');
    // #207: the erased account is a deleted account like any other — its other days' play,
    // collections and device rows are owed by the purge, queued in the SAME transaction.
    const purge = items.find((item) => item.Put?.Item?.pk.S === 'purge');
    expect(purge!.Put!.Item).toEqual({
      pk: { S: 'purge' },
      sk: { S: `account#${PLAN.from}` },
      enqueuedAt: { S: PLAN.now },
    });
  });

  it('queues NO purge when the account being left SURVIVES', async () => {
    const { store, send } = makeStore(async () => ({}));
    await store.adopt({ ...PLAN, erase: false });
    const items = (send.mock.calls[0][0] as TransactWriteItemsCommand).input.TransactItems!;
    expect(items.some((item) => item.Put?.Item?.pk.S === 'purge')).toBe(false);
  });

  // CONTRACT: the active day's play moves INSIDE this transaction — the round exists under
  // exactly one account at every instant, and an adoption that does not commit moves
  // nothing. The plan is the stores' own (`planRoundMove` / `planScoreMove`, contract-tested
  // there); what is held here is that it rides the SAME commit, what happens when it goes
  // stale, and the two races the model was written against.
  const KEY = { date: '2026-08-26', lang: 'fr' };
  const roundKey = (publicId: string) => ({
    pk: { S: `round#${publicId}` },
    sk: { S: 'fr#sentence#2026-08-26' },
  });
  const round = (
    publicId: string,
    guesses: string[],
    version: number,
    extra: Record<string, AttributeValue> = {},
  ) => ({
    ...roundKey(publicId),
    guesses: { L: guesses.map((g) => ({ S: g })) },
    puzzle: { S: 'rev1' },
    createdAt: { S: NOW.toISOString() },
    version: { N: String(version) },
    ...extra,
  });
  const scoreKey = (publicId: string) => ({
    pk: { S: 'score#2026-08-26#fr#sentence' },
    sk: { S: publicId },
  });
  // Where the moves start in an erasing adoption with a departure job: after the identity
  // (device, target check, challenge, departure job, account, profile, purge job).
  const M = 7;
  const transactions = (send: { mock: { calls: unknown[][] } }) =>
    send.mock.calls
      .map(([c]) => c)
      .filter((c): c is TransactWriteItemsCommand => c instanceof TransactWriteItemsCommand);
  const refusing = (indices: number[]) => (command: TransactWriteItemsCommand) =>
    Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: command.input.TransactItems!.map((_, index) => ({
        Code: indices.includes(index) ? 'ConditionalCheckFailed' : 'None',
      })),
    });

  it('carries the active day\'s round and score in the SAME transaction as the identity', async () => {
    const { store, send } = makeStore(async (command) => {
      if (!(command instanceof GetItemCommand)) return {};
      const key = command.input.Key!;
      if (key.pk.S === `round#${PLAN.from}`) {
        return { Item: round(PLAN.from, ['chat', 'chien'], 4, { solved: { BOOL: true } }) };
      }
      if (key.pk.S === scoreKey('').pk.S && key.sk.S === PLAN.from) {
        return { Item: { ...scoreKey(PLAN.from), score: { N: '2' }, stamp: { S: 's1' } } };
      }
      return {};
    });
    await expect(
      store.adopt({ ...PLAN, erase: true, departFrom: PLAN.from, moves: [KEY] }),
    ).resolves.toEqual({ outcome: 'adopted', moved: [{ key: KEY, solved: true }] });

    const all = transactions(send);
    expect(all).toHaveLength(1);
    const items = all[0].input.TransactItems!;
    // Identity + the round's Put/Delete + the score's Put/Delete — every one conditioned on
    // what was READ.
    expect(items).toHaveLength(M + 4);
    expect(items[M].Put).toMatchObject({
      Item: { pk: { S: `round#${PLAN.to}` }, version: { N: '1' } },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    expect(items[M + 1].Delete).toMatchObject({
      Key: roundKey(PLAN.from),
      ConditionExpression: '#v = :v',
      ExpressionAttributeValues: { ':v': { N: '4' } },
    });
    expect(items[M + 2].Put!.Item!.sk.S).toBe(PLAN.to);
    expect(items[M + 3].Delete).toMatchObject({
      Key: scoreKey(PLAN.from),
      ExpressionAttributeValues: { ':stamp': { S: 's1' } },
    });
  });

  it('moves NOTHING when the destination already holds play — and GUARDS both rows it read', async () => {
    const { store, send } = makeStore(async (command) => {
      if (!(command instanceof GetItemCommand)) return {};
      const key = command.input.Key!;
      if (key.pk.S === `round#${PLAN.from}`) return { Item: round(PLAN.from, ['chat'], 1) };
      if (key.pk.S === `round#${PLAN.to}`) return { Item: round(PLAN.to, ['souris'], 9) };
      return {};
    });
    await expect(
      store.adopt({ ...PLAN, erase: true, departFrom: PLAN.from, moves: [KEY] }),
    ).resolves.toEqual({ outcome: 'adopted', moved: [] });
    const items = transactions(send)[0].input.TransactItems!;
    expect(items).toHaveLength(M + 2);
    expect(items[M].ConditionCheck!.Key).toEqual(roundKey(PLAN.from));
    expect(items[M + 1].ConditionCheck).toMatchObject({
      Key: roundKey(PLAN.to),
      ExpressionAttributeValues: { ':v': { N: '9' } },
    });
  });

  it('plans AGAIN when only the play refused — a settle with the log untouched is carried, never copied stale', async () => {
    // The reviewer's regression: the adoption reads an unsolved round; the round route's
    // corrective settle then lands — same guesses, same puzzle, `solved` set, version
    // bumped — and the adoption's commit must refuse and re-plan, or the stale unsolved
    // copy replaces a durably solved round.
    let reads = 0;
    const { store, send } = makeStore(async (command) => {
      if (command instanceof GetItemCommand) {
        if (command.input.Key!.pk.S !== `round#${PLAN.from}`) return {};
        reads += 1;
        return {
          Item:
            reads === 1
              ? round(PLAN.from, ['chat'], 3, { progress: { N: '60' } })
              : round(PLAN.from, ['chat'], 4, { progress: { N: '100' }, solved: { BOOL: true } }),
        };
      }
      const all = transactions(send);
      if (all.length === 1) throw refusing([M + 1])(command as TransactWriteItemsCommand);
      return {};
    });
    await expect(
      store.adopt({ ...PLAN, erase: true, departFrom: PLAN.from, moves: [KEY] }),
    ).resolves.toEqual({ outcome: 'adopted', moved: [{ key: KEY, solved: true }] });
    const all = transactions(send);
    expect(all).toHaveLength(2);
    expect(all[0].input.TransactItems![M + 1].Delete!.ExpressionAttributeValues).toEqual({ ':v': { N: '3' } });
    expect(all[1].input.TransactItems![M].Put!.Item).toMatchObject({
      solved: { BOOL: true },
      progress: { N: '100' },
    });
    expect(all[1].input.TransactItems![M + 1].Delete!.ExpressionAttributeValues).toEqual({ ':v': { N: '4' } });
    // A different plan is a different request: the idempotency token moved with it.
    expect(all[1].input.ClientRequestToken).not.toBe(all[0].input.ClientRequestToken);
  });

  it('GUARDS an observed-empty source, so a first guess landing before the commit is carried rather than orphaned', async () => {
    let reads = 0;
    const { store, send } = makeStore(async (command) => {
      if (command instanceof GetItemCommand) {
        if (command.input.Key!.pk.S !== `round#${PLAN.from}`) return {};
        reads += 1;
        // Nothing there at the first plan; a first guess by then at the second.
        return reads === 1 ? {} : { Item: round(PLAN.from, ['chat'], 1) };
      }
      const all = transactions(send);
      if (all.length === 1) throw refusing([M])(command as TransactWriteItemsCommand);
      return {};
    });
    await expect(
      store.adopt({ ...PLAN, erase: true, departFrom: PLAN.from, moves: [KEY] }),
    ).resolves.toEqual({ outcome: 'adopted', moved: [{ key: KEY, solved: false }] });
    const all = transactions(send);
    const first = all[0].input.TransactItems!;
    expect(first).toHaveLength(M + 2);
    expect(first[M].ConditionCheck).toMatchObject({
      Key: roundKey(PLAN.from),
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    // The re-plan MOVES the round that appeared — and guards the score rows it read.
    const second = all[1].input.TransactItems!;
    expect(second[M].Put!.Item!.pk.S).toBe(`round#${PLAN.to}`);
    expect(second[M + 1].Delete!.Key).toEqual(roundKey(PLAN.from));
    expect(second[M + 2].ConditionCheck!.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(second[M + 3].ConditionCheck!.ConditionExpression).toBe('attribute_not_exists(pk)');
  });

  it('two sources adopting ONE target at equal versions cannot overwrite each other\'s moved log', async () => {
    // The ABA the model was amended for: the target holds an unplayed row at v2;
    // both sources hold played rounds at v2; both condition the target on v2. The first
    // copy must take the target to v3 — never keep the source's own v2 — or the second's
    // Put still passes and replaces the log the first just moved.
    const OTHER = 'cccccccccccccccc';
    const table = new Map<string, Record<string, AttributeValue>>([
      [`round#${PLAN.to}`, round(PLAN.to, [], 2)],
      [`round#${PLAN.from}`, round(PLAN.from, ['chat'], 2)],
      [`round#${OTHER}`, round(OTHER, ['chien'], 2)],
    ]);
    // A tiny table that evaluates the version conditions the way DynamoDB would. The
    // second adoption PLANS from a snapshot taken before the first commits (the race) and
    // COMMITS against the real table; its re-plan reads the real table.
    let snapshot: Map<string, Record<string, AttributeValue>> | null = null;
    const send = async (command: unknown) => {
      if (command instanceof GetItemCommand) {
        return { Item: (snapshot ?? table).get(command.input.Key!.pk.S!) };
      }
      if (!(command instanceof TransactWriteItemsCommand)) return {};
      snapshot = null;
      const items = command.input.TransactItems!;
      const holds = (index: number) => {
        const item = items[index];
        const part = item.Put ?? item.Delete ?? item.ConditionCheck ?? item.Update;
        const pk = (part as { Key?: { pk: { S: string } }; Item?: { pk: { S: string } } }).Key?.pk.S
          ?? (part as { Item?: { pk: { S: string } } }).Item?.pk.S;
        if (!pk?.startsWith('round#')) return true;
        const row = table.get(pk);
        const condition = part!.ConditionExpression;
        if (condition === 'attribute_not_exists(pk)') return row === undefined;
        if (condition === '#v = :v') return row?.version?.N === part!.ExpressionAttributeValues![':v'].N;
        return true;
      };
      const failed = items.map((_, index) => index).filter((index) => !holds(index));
      if (failed.length > 0) throw refusing(failed)(command);
      for (const item of items) {
        if (item.Put?.Item?.pk.S?.startsWith('round#')) table.set(item.Put.Item.pk.S, item.Put.Item);
        if (item.Delete?.Key?.pk.S?.startsWith('round#')) table.delete(item.Delete.Key.pk.S);
      }
      return {};
    };
    const first = makeStore(send);
    await expect(
      first.store.adopt({ ...PLAN, erase: true, departFrom: PLAN.from, moves: [KEY] }),
    ).resolves.toMatchObject({ outcome: 'adopted', moved: [{ key: KEY }] });
    expect(table.get(`round#${PLAN.to}`)).toMatchObject({
      guesses: { L: [{ S: 'chat' }] },
      version: { N: '3' },
    });

    // Both planned at v2: the second saw the target exactly as the first did.
    snapshot = new Map([[`round#${PLAN.to}`, round(PLAN.to, [], 2)]]);
    snapshot.set(`round#${OTHER}`, table.get(`round#${OTHER}`)!);
    const second = makeStore(send);
    await expect(
      second.store.adopt({
        ...PLAN,
        from: OTHER,
        departFrom: OTHER,
        erase: true,
        tokenHash: 'b'.repeat(64),
        moves: [KEY],
      }),
    ).resolves.toEqual({ outcome: 'adopted', moved: [] });
    // Its first commit was refused on the target's version and it re-planned: the target
    // now holds play, so nothing moved, and the first source's log is still the one there.
    expect(transactions(second.send)).toHaveLength(2);
    expect(table.get(`round#${PLAN.to}`)!.guesses).toEqual({ L: [{ S: 'chat' }] });
    expect(table.get(`round#${OTHER}`)!.guesses).toEqual({ L: [{ S: 'chien' }] });
  });

  it('answers the IDENTITY refusal when both an identity item and a move refused — nothing was written', async () => {
    const { store } = makeStore(async (command) => {
      if (command instanceof GetItemCommand) {
        return command.input.Key!.pk.S === `round#${PLAN.from}`
          ? { Item: round(PLAN.from, ['chat'], 1) }
          : {};
      }
      throw refusing([4, M + 1])(command as TransactWriteItemsCommand);
    });
    await expect(
      store.adopt({ ...PLAN, erase: true, departFrom: PLAN.from, moves: [KEY] }),
    ).resolves.toEqual({ outcome: 'account_changed', moved: [] });
  });

  it('reads several identity refusals in PRECEDENCE: the challenge, then an account, then the device', async () => {
    // Erasing with no departure job: [0] the device, [1] the adopted account, [2] the
    // challenge, [3] the account being left.
    const refusedAt = async (indices: number[]) => {
      const { store, send } = makeStore(async (command) => {
        if (command instanceof TransactWriteItemsCommand) throw refusing(indices)(command);
        return {};
      });
      const result = await store.adopt({ ...PLAN, erase: true });
      // An identity refusal is the ANSWER: nothing is planned or sent again.
      expect(transactions(send)).toHaveLength(1);
      return result;
    };
    await expect(refusedAt([0])).resolves.toEqual({ outcome: 'device_changed', moved: [] });
    await expect(refusedAt([0, 1])).resolves.toEqual({ outcome: 'account_changed', moved: [] });
    await expect(refusedAt([0, 3])).resolves.toEqual({ outcome: 'account_changed', moved: [] });
    await expect(refusedAt([1, 2])).resolves.toEqual({ outcome: 'challenge_changed', moved: [] });
    await expect(refusedAt([0, 1, 2, 3])).resolves.toEqual({ outcome: 'challenge_changed', moved: [] });
  });

  it('stops planning again after FOUR refused plans, loudly — play that keeps changing is not adopted', async () => {
    const { store, send, waits } = makeStore(async (command) => {
      if (command instanceof GetItemCommand) {
        return command.input.Key!.pk.S === `round#${PLAN.from}`
          ? { Item: round(PLAN.from, ['chat'], 1) }
          : {};
      }
      // The source round's guard, every time: a guess lands between each plan and its commit.
      throw refusing([M + 1])(command as TransactWriteItemsCommand);
    });
    await expect(
      store.adopt({ ...PLAN, erase: true, departFrom: PLAN.from, moves: [KEY] }),
    ).rejects.toThrow(/kept changing/);
    expect(transactions(send)).toHaveLength(4);
    // A refusal is the play having changed, not contention: it plans again at once.
    expect(waits).toEqual([]);
  });
});

// CONTRACT (PR-227 review): AWS documents that the SDKs do NOT retry a
// `TransactionCanceledException`, and that item-level contention is reported as
// `TransactionConflict`. Every transaction in this file therefore handles it explicitly —
// bounded, jittered, and re-reading first wherever its items came from a read — and NO
// condition from a contended attempt is ever read as a business verdict.
describe('dynamoLinkStore — transaction conflicts', () => {
  const PLAN = {
    tokenHash: HASH,
    deviceId: 'dddddddddddddddd',
    from: 'bbbbbbbbbbbbbbbb',
    to: 'aaaaaaaaaaaaaaaa',
    emailHash: 'e'.repeat(64),
    codeHash: 'c'.repeat(64),
    now: NOW.toISOString(),
  };
  const BIND = {
    emailHash: 'e'.repeat(64),
    codeHash: 'c'.repeat(64),
    email: 'zoe@example.com',
    accountId: 'aaaaaaaaaaaaaaaa',
    now: NOW.toISOString(),
  };
  const HOUR = 3_600;
  const ALLOWANCE = [{ scope: 'addr', hash: HASH, limit: 5 }];

  it('BIND: one conflict, then success — and the wait sits BETWEEN attempts, never before', async () => {
    let sends = 0;
    const { store, send, waits } = makeStore(async (command) => {
      if (!(command instanceof TransactWriteItemsCommand)) return {};
      sends += 1;
      if (sends === 1) throw cancelling('TransactionConflict', 'None', 'None');
      return {};
    });
    await expect(store.bind(BIND)).resolves.toBe('bound');
    expect(sends).toBe(2);
    // ONE wait, and it is the conflict schedule's first window — never an immediate retry.
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(0);
    expect(waits[0]).toBeLessThanOrEqual(20);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('BIND: a conflict then a REAL condition refusal answers the condition, not the conflict', async () => {
    let sends = 0;
    const { store } = makeStore(async (command) => {
      if (!(command instanceof TransactWriteItemsCommand)) return {};
      sends += 1;
      if (sends === 1) throw cancelling('TransactionConflict');
      // The binding Put refused: another device won this address.
      throw cancelling('ConditionalCheckFailed', 'None', 'None');
    });
    await expect(store.bind(BIND)).resolves.toBe('taken');
    expect(sends).toBe(2);
  });

  it('BIND: a MIXED conflict + conditional cancellation is NOT a verdict — it is tried again', async () => {
    // The whole point of the classifier: `ConditionalCheckFailed` beside a
    // `TransactionConflict` describes rows another transaction was mid-write on. Reading
    // it would answer `challenge_changed` for a link nothing was wrong with.
    let sends = 0;
    const { store } = makeStore(async (command) => {
      if (!(command instanceof TransactWriteItemsCommand)) return {};
      sends += 1;
      if (sends === 1) throw cancelling('None', 'None', 'ConditionalCheckFailed', 'TransactionConflict');
      return {};
    });
    await expect(store.bind(BIND)).resolves.toBe('bound');
    expect(sends).toBe(2);
  });

  it('BIND: a reason with NO code is OPERATIONAL and surfaces — it is not silently "None"', async () => {
    const { store, waits } = makeStore(async (command) => {
      if (!(command instanceof TransactWriteItemsCommand)) return {};
      throw cancelling('ConditionalCheckFailed', undefined, 'None');
    });
    await expect(store.bind(BIND)).rejects.toThrow(/cancelled/);
    expect(waits).toEqual([]);
  });

  it('BIND: a THROTTLE inside a cancellation is operational too, and is never retried here', async () => {
    let sends = 0;
    const { store } = makeStore(async (command) => {
      if (!(command instanceof TransactWriteItemsCommand)) return {};
      sends += 1;
      throw cancelling('ThrottlingError', 'None', 'None');
    });
    await expect(store.bind(BIND)).rejects.toThrow(/cancelled/);
    expect(sends).toBe(1);
  });

  it('BIND: conflict exhaustion is BOUNDED and throws the cancellation it could not win', async () => {
    let sends = 0;
    const { store, waits } = makeStore(async (command) => {
      if (!(command instanceof TransactWriteItemsCommand)) return {};
      sends += 1;
      throw cancelling('TransactionConflict');
    });
    await expect(store.bind(BIND)).rejects.toThrow(/cancelled/);
    // CONFLICT_RETRY_ATTEMPTS waits, so one send more than that.
    expect(sends).toBe(5);
    expect(waits).toHaveLength(4);
  });

  it('SEND ALLOWANCE: a conflict is decided again from a FRESH read, never from the stale view', async () => {
    let reads = 0;
    let sends = 0;
    const { store, waits } = makeStore(async (command) => {
      if (command instanceof GetItemCommand) {
        reads += 1;
        return reads === 1 ? {} : { Item: { sends: { L: [{ N: String(NOW.getTime() - 10) }] } } };
      }
      sends += 1;
      if (sends === 1) throw cancelling('TransactionConflict');
      return {};
    });
    await expect(store.spendSends(ALLOWANCE, HOUR, NOW)).resolves.toBe(true);
    // Read, refused, WAITED, read AGAIN, written: the bound is on what is STORED.
    expect(reads).toBe(2);
    expect(waits).toHaveLength(1);
  });

  it('SEND ALLOWANCE: conflict exhaustion surfaces instead of silently granting a send', async () => {
    const { store, waits } = makeStore(async (command) => {
      if (command instanceof GetItemCommand) return {};
      throw cancelling('TransactionConflict');
    });
    await expect(store.spendSends(ALLOWANCE, HOUR, NOW)).rejects.toThrow(/cancelled/);
    expect(waits).toHaveLength(4);
  });

  it('ADOPT: a conflict RE-PLANS from fresh reads — the rival may have moved a guarded row', async () => {
    const KEY = { date: '2026-08-26', lang: 'fr' };
    let reads = 0;
    let sends = 0;
    const { store, send, waits } = makeStore(async (command) => {
      if (command instanceof GetItemCommand) {
        if (command.input.Key!.pk.S !== `round#${PLAN.from}`) return {};
        reads += 1;
        return {
          Item: {
            pk: { S: `round#${PLAN.from}` },
            sk: { S: 'fr#sentence#2026-08-26' },
            guesses: { L: [{ S: 'chat' }] },
            puzzle: { S: 'rev1' },
            // The rival's write landed between the two plans.
            version: { N: reads === 1 ? '3' : '4' },
          },
        };
      }
      sends += 1;
      if (sends === 1) throw cancelling('None', 'None', 'None', 'None', 'None', 'None', 'TransactionConflict', 'None');
      return {};
    });
    await expect(
      store.adopt({ ...PLAN, erase: true, departFrom: PLAN.from, moves: [KEY] }),
    ).resolves.toMatchObject({ outcome: 'adopted' });
    expect(reads).toBe(2);
    expect(waits).toHaveLength(1);
    const all = send.mock.calls
      .map(([c]) => c)
      .filter((c): c is TransactWriteItemsCommand => c instanceof TransactWriteItemsCommand);
    // The second plan conditions on what NOW stands, and is a different request. (The
    // source round's Delete follows the seven identity items and the destination's Put.)
    expect(all[1].input.TransactItems![8].Delete!.ExpressionAttributeValues).toEqual({
      ':v': { N: '4' },
    });
    expect(all[1].input.ClientRequestToken).not.toBe(all[0].input.ClientRequestToken);
  });

  it('ADOPT: identity precedence still holds — but only on a CONFLICT-FREE attempt', async () => {
    let sends = 0;
    const { store } = makeStore(async (command) => {
      if (command instanceof GetItemCommand) return {};
      sends += 1;
      // A contended attempt whose challenge condition ALSO reads as refused must not
      // answer `challenge_changed`; the conflict-free retry is what classifies.
      if (sends === 1) throw cancelling('None', 'None', 'ConditionalCheckFailed', 'TransactionConflict');
      throw cancelling('None', 'ConditionalCheckFailed', 'None', 'None');
    });
    await expect(store.adopt({ ...PLAN, erase: false })).resolves.toEqual({
      outcome: 'account_changed',
      moved: [],
    });
    expect(sends).toBe(2);
  });

  it('ADOPT: conflict exhaustion is bounded and loud', async () => {
    const { store, waits } = makeStore(async (command) => {
      if (command instanceof GetItemCommand) return {};
      throw cancelling('TransactionConflict');
    });
    await expect(store.adopt({ ...PLAN, erase: false })).rejects.toThrow(/cancelled/);
    expect(waits).toHaveLength(4);
  });
});

describe('dynamoLinkStore — the departure queue', () => {
  it('lists the jobs an adoption left queued: ONE consistent, paged Query of the account\'s own partition', async () => {
    const pages = [
      {
        Items: [{ sk: { S: 'from#cccccccccccccccc' } }],
        LastEvaluatedKey: { pk: { S: 'cursor' } },
      },
      { Items: [{ sk: { S: 'from#bbbbbbbbbbbbbbbb' } }] },
    ];
    const { store, send } = makeStore(async () => pages.shift()!);
    // The ids the rows name, without their prefix, in a stable order.
    await expect(store.pendingDepartures('aaaaaaaaaaaaaaaa')).resolves.toEqual([
      'bbbbbbbbbbbbbbbb',
      'cccccccccccccccc',
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    const first = (send.mock.calls[0][0] as QueryCommand).input;
    expect(send.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
    expect(first).toMatchObject({
      TableName: 'scores',
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
      ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: {
        ':pk': { S: 'depart#aaaaaaaaaaaaaaaa' },
        ':prefix': { S: 'from#' },
      },
      // A job the adoption just committed must be visible to the drain that follows it.
      ConsistentRead: true,
    });
    expect(first.ExclusiveStartKey).toBeUndefined();
    const second = (send.mock.calls[1][0] as QueryCommand).input;
    expect(second.ExclusiveStartKey).toEqual({ pk: { S: 'cursor' } });
  });

  it('deletes a finished job unconditionally, so finishing twice is a no-op', async () => {
    const { store, send } = makeStore(async () => ({}));
    await store.clearDeparture('aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb');
    const command = send.mock.calls[0][0] as DeleteItemCommand;
    expect(command.input.Key).toEqual({
      pk: { S: 'depart#aaaaaaaaaaaaaaaa' },
      sk: { S: 'from#bbbbbbbbbbbbbbbb' },
    });
    expect(command.input.ConditionExpression).toBeUndefined();
  });
});

// CONTRACT (#207): a player's own deletion is ONE transaction — the account row conditioned
// on the exact address it was authenticated with, the profile row, the address's binding
// (never one reaching somebody else) and the purge job, which names no address.
describe('dynamoLinkStore — deleting an account', () => {
  const ID = 'aaaaaaaaaaaaaaaa';
  const EMAIL = 'zoe@example.com';
  const DELETION = { accountId: ID, tokenHash: HASH, now: NOW.toISOString() };
  const sent = (send: ReturnType<typeof makeStore>['send']) =>
    send.mock.calls
      .map(([c]) => c)
      .filter((c): c is TransactWriteItemsCommand => c instanceof TransactWriteItemsCommand);

  it('deletes an UNLINKED account: its row (still unlinked, the caller still on it), its profile, and queues the purge', async () => {
    const { store, send } = makeStore(async () => ({}));
    await expect(store.deleteAccount(DELETION)).resolves.toBe('deleted');
    const [command] = sent(send);
    expect(command.input.ClientRequestToken).toBeTruthy();
    const items = command.input.TransactItems!;
    expect(items).toHaveLength(4);
    expect(items[0].Delete).toMatchObject({
      Key: { pk: { S: `player#${ID}` }, sk: { S: 'account' } },
      ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(#email)',
    });
    // The CALLING device must still be on this account: a link that moved it meanwhile
    // refuses the deletion of the account it left.
    expect(items[1].ConditionCheck).toEqual({
      TableName: 'scores',
      Key: { pk: { S: `device#${HASH}` }, sk: { S: 'device' } },
      ConditionExpression: '#accountId = :accountId',
      ExpressionAttributeNames: { '#accountId': 'accountId' },
      ExpressionAttributeValues: { ':accountId': { S: ID } },
    });
    expect(items[2].Delete).toEqual({
      TableName: 'scores',
      Key: { pk: { S: `player#${ID}` }, sk: { S: 'profile' } },
    });
    expect(items[3].Put).toEqual({
      TableName: 'scores',
      Item: { pk: { S: 'purge' }, sk: { S: `account#${ID}` }, enqueuedAt: { S: NOW.toISOString() } },
    });
  });

  it('deletes a LINKED account only while it carries that address, and frees the binding — never another account\'s', async () => {
    const { store, send } = makeStore(async () => ({}));
    await store.deleteAccount({ ...DELETION, email: EMAIL });
    const items = sent(send)[0].input.TransactItems!;
    expect(items).toHaveLength(5);
    expect(items[0].Delete).toMatchObject({
      ConditionExpression: 'attribute_exists(pk) AND #email = :email',
      ExpressionAttributeValues: { ':email': { S: EMAIL } },
    });
    expect(items[3].Delete).toMatchObject({
      Key: { pk: { S: `email#${emailHashOf(EMAIL)}` }, sk: { S: 'email' } },
      ConditionExpression: 'attribute_not_exists(pk) OR #accountId = :accountId',
      ExpressionAttributeValues: { ':accountId': { S: ID } },
    });
    // The job carries the account and the instant, never the address.
    expect(JSON.stringify(items[4])).not.toContain(EMAIL);
  });

  it('answers `account_changed` when the ACCOUNT row refused (a bind or another deletion won)', async () => {
    const { store } = makeStore(async () => {
      throw cancelling('ConditionalCheckFailed', 'None', 'None', 'None');
    });
    await expect(store.deleteAccount(DELETION)).resolves.toBe('account_changed');
  });

  it('answers `account_changed` when the CALLING DEVICE refused (a link moved it to another account)', async () => {
    const { store } = makeStore(async () => {
      throw cancelling('None', 'ConditionalCheckFailed', 'None', 'None');
    });
    await expect(store.deleteAccount(DELETION)).resolves.toBe('account_changed');
  });

  it('names the CALLING DEVICE in its idempotency token — two devices deleting at one instant are two requests', async () => {
    const { store, send } = makeStore(async () => ({}));
    await store.deleteAccount(DELETION);
    await store.deleteAccount({ ...DELETION, tokenHash: 'b'.repeat(64) });
    const [first, second] = sent(send);
    expect(second.input.ClientRequestToken).not.toBe(first.input.ClientRequestToken);
  });

  it('THROWS when only the binding refused — an address reaching another account is not an answer', async () => {
    const { store } = makeStore(async () => {
      throw cancelling('None', 'None', 'None', 'ConditionalCheckFailed', 'None');
    });
    await expect(store.deleteAccount({ ...DELETION, email: EMAIL })).rejects.toThrow('cancelled');
  });

  it('retries a CONFLICT with the same items and token after a wait, then reads only a clean attempt', async () => {
    let attempts = 0;
    const { store, send, waits } = makeStore(async () => {
      attempts += 1;
      if (attempts === 1) throw cancelling('TransactionConflict', 'None', 'None', 'None');
      return {};
    });
    await expect(store.deleteAccount(DELETION)).resolves.toBe('deleted');
    const [first, second] = sent(send);
    expect(second.input).toEqual(first.input);
    expect(waits).toHaveLength(1);
  });
});

describe('dynamoLinkStore — the purge queue', () => {
  it('lists every job with ONE consistent, paged Query of the fixed partition — oldest first', async () => {
    const pages = [
      {
        Items: [
          { sk: { S: 'account#bbbbbbbbbbbbbbbb' }, enqueuedAt: { S: '2026-08-26T12:00:00.000Z' } },
        ],
        LastEvaluatedKey: { pk: { S: 'cursor' } },
      },
      {
        Items: [
          { sk: { S: 'account#cccccccccccccccc' }, enqueuedAt: { S: '2026-08-25T12:00:00.000Z' } },
        ],
      },
    ];
    const { store, send } = makeStore(async () => pages.shift()!);
    await expect(store.pendingPurges()).resolves.toEqual([
      { accountId: 'cccccccccccccccc', enqueuedAt: '2026-08-25T12:00:00.000Z' },
      { accountId: 'bbbbbbbbbbbbbbbb', enqueuedAt: '2026-08-26T12:00:00.000Z' },
    ]);
    const first = (send.mock.calls[0][0] as QueryCommand).input;
    expect(first).toMatchObject({
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
      ExpressionAttributeValues: { ':pk': { S: 'purge' }, ':prefix': { S: 'account#' } },
      ConsistentRead: true,
    });
    expect((send.mock.calls[1][0] as QueryCommand).input.ExclusiveStartKey).toEqual({
      pk: { S: 'cursor' },
    });
  });

  it('clears a finished job unconditionally, so finishing twice is a no-op', async () => {
    const { store, send } = makeStore(async () => ({}));
    await store.clearPurge('aaaaaaaaaaaaaaaa');
    const command = send.mock.calls[0][0] as DeleteItemCommand;
    expect(command.input.Key).toEqual({ pk: { S: 'purge' }, sk: { S: 'account#aaaaaaaaaaaaaaaa' } });
    expect(command.input.ConditionExpression).toBeUndefined();
  });

  it('sweeps the WHOLE player partition, page by page, deleting every item it lists', async () => {
    const pages = [
      { Items: [{ sk: { S: 'history#fr' } }, { sk: { S: 'profile' } }], LastEvaluatedKey: { pk: { S: 'c' } } },
      { Items: [{ sk: { S: 'group#gaaaaaaaaaaaaaaa' } }] },
    ];
    const { store, send } = makeStore(async (command) =>
      command instanceof QueryCommand ? pages.shift()! : {},
    );
    await store.purgePlayer('aaaaaaaaaaaaaaaa');
    const commands = send.mock.calls.map(([c]) => c);
    const query = (commands[0] as QueryCommand).input;
    expect(query).toMatchObject({
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeValues: { ':pk': { S: 'player#aaaaaaaaaaaaaaaa' } },
      ProjectionExpression: '#pk, #sk',
      ConsistentRead: true,
    });
    const deletes = commands
      .filter((c): c is DeleteItemCommand => c instanceof DeleteItemCommand)
      .map((c) => {
        expect(c.input.ConditionExpression).toBeUndefined();
        return c.input.Key;
      });
    expect(deletes).toEqual(
      ['history#fr', 'profile', 'group#gaaaaaaaaaaaaaaa'].map((sk) => ({
        pk: { S: 'player#aaaaaaaaaaaaaaaa' },
        sk: { S: sk },
      })),
    );
  });
});
