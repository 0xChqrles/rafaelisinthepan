import { describe, expect, it, vi } from 'vitest';
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  GetItemCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { LINK_CODE_MAX_ATTEMPTS } from '@whippin/shared';
import { dynamoLinkStore } from './dynamoLinkStore';

// CONTRACT (#204), and it is the round store's contract restated for a second write path:
// DynamoDB rejects an ExpressionAttributeNames/Values entry no expression references, and an
// alias no entry declares, with a ValidationException BEFORE anything is written — and its
// CONDITION grammar has no arithmetic and exactly six functions. A mocked client validates
// neither, so a command that would fail every production call looks perfectly fine here
// unless the SHAPE of the expression is what the suite holds. This file's writes are the
// ones nothing local can exercise: an account is DELETED by them.

const CONDITION_FUNCTIONS = [
  'attribute_exists',
  'attribute_not_exists',
  'attribute_type',
  'begins_with',
  'contains',
  'size',
];

interface Expressed {
  UpdateExpression?: string;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
}

function expectAliasesMatch(input: Expressed): void {
  const source = `${input.UpdateExpression ?? ''} ${input.ConditionExpression ?? ''}`;
  const check = (pattern: RegExp, declared: object | undefined, what: string) => {
    const used = new Set(source.match(pattern) ?? []);
    const keys = new Set(Object.keys(declared ?? {}));
    expect([...keys].filter((k) => !used.has(k)), `${what} declared but unused`).toEqual([]);
    expect([...used].filter((k) => !keys.has(k)), `${what} used but undeclared`).toEqual([]);
  };
  check(/#[A-Za-z0-9_]+/g, input.ExpressionAttributeNames, 'name');
  check(/:[A-Za-z0-9_]+/g, input.ExpressionAttributeValues, 'value');
  const condition = input.ConditionExpression;
  if (condition === undefined) return;
  for (const match of condition.matchAll(/([A-Za-z_]+)\s*\(/g)) {
    if (['AND', 'OR', 'NOT'].includes(match[1].toUpperCase())) continue;
    expect(CONDITION_FUNCTIONS, condition).toContain(match[1]);
  }
  // `if_not_exists` and `+` belong to an UPDATE expression's SET action, never a condition.
  expect(condition).not.toMatch(/[+*/]/);
  expect(condition).not.toMatch(/if_not_exists/);
}

// Every store here is built over this, so no write in this file escapes the checks.
function makeStore(send: (command: unknown) => Promise<unknown>) {
  const checked = vi.fn(async (command: unknown) => {
    if (command instanceof UpdateItemCommand) expectAliasesMatch(command.input);
    if (command instanceof TransactWriteItemsCommand) {
      for (const item of command.input.TransactItems ?? []) {
        for (const part of [item.Put, item.Delete, item.Update, item.ConditionCheck]) {
          if (part) expectAliasesMatch(part as Expressed);
        }
      }
    }
    return send(command);
  });
  return {
    store: dynamoLinkStore({ send: checked } as unknown as DynamoDBClient, 'scores'),
    send: checked,
  };
}

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
    // …and refuses while a LIVE adoption claim holds the account (a stale one does not).
    expect(items[1].Update!.ConditionExpression).toContain(
      '(attribute_not_exists(#linkTo) OR #linkAt <= :stale)',
    );
    expect(items[1].Update!.ExpressionAttributeValues![':stale'].N).toBe(
      String(Math.floor(NOW.getTime() / 1_000) - 600),
    );
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

  it('deletes the account row AND its profile row together when it is being erased', async () => {
    const { store, send } = makeStore(async () => ({}));
    await store.adopt({ ...PLAN, erase: true, mergeFrom: PLAN.from });

    const items = (send.mock.calls[0][0] as TransactWriteItemsCommand).input.TransactItems!;
    const deleted = items.flatMap((item) => (item.Delete ? [item.Delete.Key!.pk.S] : []));
    // The profile row too: an identity-bearing read resolves a face through it, so leaving
    // it behind would keep exposing an account the player has left for good.
    expect(deleted).toContain(`player#${PLAN.from}`);
    expect(deleted.filter((pk) => pk === `player#${PLAN.from}`)).toHaveLength(2);
    // The friend-merge job is persisted in the SAME transaction that deletes the account,
    // which is what makes the fan-out behind it durable.
    const job = items.find((item) => item.Put?.Item?.pk.S === `merge#${PLAN.to}`);
    expect(job!.Put!.Item!.sk.S).toBe(`from#${PLAN.from}`);
    const source = items.find(
      (item) => item.Delete?.Key?.pk.S === `player#${PLAN.from}` && item.Delete.Key.sk.S === 'account',
    );
    expect(source!.Delete!.ConditionExpression).toContain('attribute_not_exists(#email)');
    // The source is deleted only under THIS target's claim: the play that moved before this
    // transaction moved under it.
    expect(source!.Delete!.ConditionExpression).toContain('#linkTo = :to');
    expect(source!.Delete!.ExpressionAttributeValues![':to'].S).toBe(PLAN.to);
  });
});

// CONTRACT: an ERASING adoption claims the source account for one target BEFORE its play
// moves, on the account row itself. The same target renews; a different one waits for the
// claim to go stale; an account that gained an address or vanished cannot be claimed.
describe('dynamoLinkStore — the adoption claim', () => {
  const input = { from: 'bbbbbbbbbbbbbbbb', to: 'aaaaaaaaaaaaaaaa', now: NOW.toISOString() };

  it('is ONE conditional update on the account row, passing its own target and a stale claim', async () => {
    const { store, send } = makeStore(async () => ({}));
    await expect(store.claimAdoption(input)).resolves.toBe('claimed');
    const command = send.mock.calls[0][0] as UpdateItemCommand;
    expect(command).toBeInstanceOf(UpdateItemCommand);
    expect(command.input.Key).toEqual({ pk: { S: `player#${input.from}` }, sk: { S: 'account' } });
    expect(command.input.UpdateExpression).toBe('SET #linkTo = :to, #linkAt = :now');
    expect(command.input.ConditionExpression).toBe(
      'attribute_exists(pk) AND attribute_not_exists(#email)' +
        ' AND (attribute_not_exists(#linkTo) OR #linkTo = :to OR #linkAt <= :stale)',
    );
    expect(command.input.ExpressionAttributeValues![':stale'].N).toBe(
      String(Math.floor(NOW.getTime() / 1_000) - 600),
    );
  });

  it('classifies a refusal by one consistent read: elsewhere / account changed', async () => {
    const refusing = (item: Record<string, AttributeValue> | undefined) =>
      makeStore(async (command) => {
        if (command instanceof GetItemCommand) {
          expect(command.input.ConsistentRead).toBe(true);
          return { Item: item };
        }
        throw new ConditionalCheckFailedException({ message: 'nope', $metadata: {} });
      });
    await expect(
      refusing({ linkTo: { S: 'cccccccccccccccc' }, linkAt: { N: '1' } }).store.claimAdoption(input),
    ).resolves.toBe('claimed_elsewhere');
    await expect(
      refusing({ email: { S: 'zoe@example.com' } }).store.claimAdoption(input),
    ).resolves.toBe('account_changed');
    await expect(refusing(undefined).store.claimAdoption(input)).resolves.toBe('account_changed');
  });
});

describe('dynamoLinkStore — the merge queue', () => {
  it('deletes a finished job unconditionally, so finishing twice is a no-op', async () => {
    const { store, send } = makeStore(async () => ({}));
    await store.clearMerge('aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb');
    const command = send.mock.calls[0][0] as DeleteItemCommand;
    expect(command.input.Key).toEqual({
      pk: { S: 'merge#aaaaaaaaaaaaaaaa' },
      sk: { S: 'from#bbbbbbbbbbbbbbbb' },
    });
    expect(command.input.ConditionExpression).toBeUndefined();
  });
});
