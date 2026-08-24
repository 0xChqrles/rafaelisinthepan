import { describe, expect, it, vi } from 'vitest';
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  GetItemCommand,
  QueryCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { dynamoDeviceStore } from './dynamoDeviceStore';

const ACCOUNT = 'a'.repeat(16);
const DEVICE = 'd'.repeat(16);
const REVOKE_KEY = 'f'.repeat(64);

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
