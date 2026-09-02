import { describe, expect, it, vi } from 'vitest';
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { dynamoDeviceStore } from './dynamoDeviceStore';

const ACCOUNT = 'a'.repeat(16);
const DEVICE = 'd'.repeat(16);
const REVOKE_KEY = 'f'.repeat(64);

describe('dynamoDeviceStore authentication (#204/#216)', () => {
  it('retains the account email that decides whether leaving it may erase it', async () => {
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(GetItemCommand);
      const pk = ((command as GetItemCommand).input.Key?.pk as { S: string }).S;
      if (pk === `device#${REVOKE_KEY}`) {
        return {
          Item: {
            deviceId: { S: DEVICE },
            accountId: { S: ACCOUNT },
            createdAt: { S: '2026-08-25T00:00:00.000Z' },
          },
        };
      }
      return {
        Item: {
          createdAt: { S: '2026-08-20T00:00:00.000Z' },
          email: { S: 'zoe@example.com' },
        },
      };
    });
    const store = dynamoDeviceStore({ send } as unknown as DynamoDBClient, 'scores');

    await expect(store.resolve(REVOKE_KEY)).resolves.toMatchObject({
      account: { accountId: ACCOUNT, email: 'zoe@example.com' },
    });
  });
});

describe('dynamoDeviceStore revocation (#216)', () => {
  it('deletes the listed BASE item directly, without an eventually-consistent lookup', async () => {
    const send = vi.fn(async (_command: unknown) => ({}));
    const store = dynamoDeviceStore({ send } as unknown as DynamoDBClient, 'scores');

    await expect(store.revoke(ACCOUNT, DEVICE, REVOKE_KEY)).resolves.toBe('removed');
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as DeleteItemCommand;
    expect(command).toBeInstanceOf(DeleteItemCommand);
    expect(command).not.toBeInstanceOf(QueryCommand);
    expect(command.input).toMatchObject({
      TableName: 'scores',
      Key: { pk: { S: `device#${REVOKE_KEY}` }, sk: { S: 'device' } },
      ConditionExpression: '#accountId = :accountId AND #deviceId = :deviceId',
      ExpressionAttributeValues: {
        ':accountId': { S: ACCOUNT },
        ':deviceId': { S: DEVICE },
      },
    });
  });

  it('strongly distinguishes an already-absent row after a failed delete condition', async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof DeleteItemCommand) {
        throw new ConditionalCheckFailedException({ $metadata: {}, message: 'already gone' });
      }
      return {};
    });
    const store = dynamoDeviceStore({ send } as unknown as DynamoDBClient, 'scores');

    await expect(store.revoke(ACCOUNT, DEVICE, REVOKE_KEY)).resolves.toBe('absent');
    expect(send).toHaveBeenCalledTimes(2);
    const read = send.mock.calls[1][0] as GetItemCommand;
    expect(read).toBeInstanceOf(GetItemCommand);
    expect(read.input).toMatchObject({
      Key: { pk: { S: `device#${REVOKE_KEY}` }, sk: { S: 'device' } },
      ConsistentRead: true,
    });
  });

  it('reports a mismatch for a row that EXISTS but does not parse — never absent', async () => {
    // An existing-but-unparseable item read as `absent` would filter a live device out of
    // the returned list: the classification asks only whether the ITEM exists.
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof DeleteItemCommand) {
        throw new ConditionalCheckFailedException({ $metadata: {}, message: 'stale handle' });
      }
      return { Item: { pk: { S: `device#${REVOKE_KEY}` } } };
    });
    const store = dynamoDeviceStore({ send } as unknown as DynamoDBClient, 'scores');

    await expect(store.revoke(ACCOUNT, DEVICE, REVOKE_KEY)).resolves.toBe('mismatch');
  });

  it('reports an ownership mismatch when the addressed row still exists', async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof DeleteItemCommand) {
        throw new ConditionalCheckFailedException({ $metadata: {}, message: 'stale handle' });
      }
      return {
        Item: {
          deviceId: { S: 'q'.repeat(16) },
          accountId: { S: ACCOUNT },
        },
      };
    });
    const store = dynamoDeviceStore({ send } as unknown as DynamoDBClient, 'scores');

    await expect(store.revoke(ACCOUNT, DEVICE, REVOKE_KEY)).resolves.toBe('mismatch');
  });

  it('propagates operational failures instead of claiming the device was removed', async () => {
    const send = vi.fn(async () => {
      throw new Error('throttled');
    });
    const store = dynamoDeviceStore({ send } as unknown as DynamoDBClient, 'scores');

    await expect(store.revoke(ACCOUNT, DEVICE, REVOKE_KEY)).rejects.toThrow('throttled');
  });

  it('returns each index row with the opaque base-item handle it projects', async () => {
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(QueryCommand);
      return {
        Items: [
          {
            pk: { S: `device#${REVOKE_KEY}` },
            deviceId: { S: DEVICE },
            accountId: { S: ACCOUNT },
            agent: {
              M: {
                device: { S: 'Mac' },
                os: { S: 'macOS' },
                browser: { S: 'Safari' },
              },
            },
            createdAt: { S: '2026-08-23T00:00:00.000Z' },
            lastSeenAt: { S: '2026-08-24T00:00:00.000Z' },
          },
        ],
      };
    });
    const store = dynamoDeviceStore({ send } as unknown as DynamoDBClient, 'scores');

    await expect(store.list(ACCOUNT)).resolves.toEqual([
      {
        revokeKey: REVOKE_KEY,
        deviceId: DEVICE,
        accountId: ACCOUNT,
        agent: { device: 'Mac', os: 'macOS', browser: 'Safari' },
        createdAt: '2026-08-23T00:00:00.000Z',
        lastSeenAt: '2026-08-24T00:00:00.000Z',
      },
    ]);
  });
});

describe('dynamoDeviceStore bootstrap (#216)', () => {
  const TOKEN_HASH = 'c'.repeat(64);
  const INPUT = {
    tokenHash: TOKEN_HASH,
    accountId: 'n'.repeat(16),
    deviceId: 'm'.repeat(16),
    agent: { device: 'iPhone', os: 'iOS', browser: 'Safari' },
    now: '2026-08-25T00:00:00.000Z',
  };

  it('re-parents an ORPHANED device item (account row gone) instead of throwing', async () => {
    // The memory store's documented behaviour, and the client's only recovery: the
    // persisted token is re-sent on every retry, so a deterministic failure here is an
    // account creation that can never succeed on that device again.
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetItemCommand) {
        const pk = (command.input.Key?.pk as { S: string }).S;
        if (pk === `device#${TOKEN_HASH}`) {
          return {
            Item: {
              pk: { S: `device#${TOKEN_HASH}` },
              deviceId: { S: 'o'.repeat(16) },
              accountId: { S: 'g'.repeat(16) }, // the dead account
              createdAt: { S: '2026-08-20T00:00:00.000Z' },
              lastSeenAt: { S: '2026-08-20T00:00:00.000Z' },
            },
          };
        }
        return {}; // the account row is gone
      }
      expect(command).toBeInstanceOf(TransactWriteItemsCommand);
      return {};
    });
    const store = dynamoDeviceStore({ send } as unknown as DynamoDBClient, 'scores');

    const resolved = await store.bootstrap(INPUT);
    expect(resolved.account.accountId).toBe(INPUT.accountId);
    expect(resolved.device.deviceId).toBe(INPUT.deviceId);

    const write = send.mock.calls.find(
      ([command]) => command instanceof TransactWriteItemsCommand,
    )?.[0] as TransactWriteItemsCommand;
    const devicePut = write.input.TransactItems?.[1]?.Put;
    // Overwrites the orphaned item — but only while it still names the dead account it
    // was read with, so a racing re-parent fails into the adopt path.
    expect(devicePut?.ConditionExpression).toBe('#accountId = :orphaned');
    expect(devicePut?.ExpressionAttributeValues).toMatchObject({
      ':orphaned': { S: 'g'.repeat(16) },
    });
  });

  it('creates fresh identities with create-only puts when no device item exists', async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetItemCommand) return {};
      return {};
    });
    const store = dynamoDeviceStore({ send } as unknown as DynamoDBClient, 'scores');

    await store.bootstrap(INPUT);
    const write = send.mock.calls.find(
      ([command]) => command instanceof TransactWriteItemsCommand,
    )?.[0] as TransactWriteItemsCommand;
    for (const item of write.input.TransactItems ?? []) {
      expect(item.Put?.ConditionExpression).toBe('attribute_not_exists(pk)');
    }
  });
});
