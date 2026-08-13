import { describe, expect, it, vi } from 'vitest';
import {
  GetItemCommand,
  TransactWriteItemsCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { dynamoScoreStore } from './dynamoScoreStore';
import { SCORE_SUBMISSION_LIMIT, type ScoreIncrement, type ScoreKey } from './scoreStore';

const KEY: ScoreKey = { date: '2026-08-13', lang: 'fr', mode: 'word' };
const INCREMENT: ScoreIncrement = {
  ...KEY,
  ipHash: 'abcdef0123456789',
  bucket: 3,
  bucketCount: 13,
  expiresAt: 1_800_000_000,
  requestToken: '0123456789abcdef0123456789abcdef0123',
};

describe('dynamoScoreStore', () => {
  it('reads one aggregate item consistently and expands absent counters to zero', async () => {
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(GetItemCommand);
      return { Item: { b0: { N: '2' }, b2: { N: '4' }, total: { N: '6' } } };
    });
    const store = dynamoScoreStore({ send } as unknown as DynamoDBClient, 'scores');
    await expect(store.get(KEY, 4)).resolves.toEqual({ buckets: [2, 0, 4, 0], total: 6 });
    const input = (send.mock.calls[0][0] as GetItemCommand).input;
    expect(input).toMatchObject({
      TableName: 'scores',
      ConsistentRead: true,
      Key: { pk: { S: 'score#2026-08-13#fr#word' } },
    });
  });

  it('atomically updates the capped dedup item and aggregate bucket in one transaction', async () => {
    const send = vi.fn(async (_command: unknown) => ({}));
    const store = dynamoScoreStore({ send } as unknown as DynamoDBClient, 'scores');
    await expect(store.increment(INCREMENT)).resolves.toBe(true);

    const command = send.mock.calls[0][0] as TransactWriteItemsCommand;
    expect(command).toBeInstanceOf(TransactWriteItemsCommand);
    expect(command.input.ClientRequestToken).toBe(INCREMENT.requestToken);
    expect(command.input.TransactItems).toHaveLength(2);
    const [dedup, aggregate] = command.input.TransactItems!;
    expect(dedup.Update).toMatchObject({
      TableName: 'scores',
      Key: { pk: { S: `dedup#2026-08-13#fr#word#${INCREMENT.ipHash}` } },
      ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
      ExpressionAttributeValues: {
        ':limit': { N: String(SCORE_SUBMISSION_LIMIT) },
        ':expiresAt': { N: String(INCREMENT.expiresAt) },
      },
    });
    expect(aggregate.Update).toMatchObject({
      Key: { pk: { S: 'score#2026-08-13#fr#word' } },
      UpdateExpression: 'ADD #bucket :one, #total :one',
      ExpressionAttributeNames: { '#bucket': 'b3', '#total': 'total' },
    });
  });

  it('maps only the cap condition failure to false and rethrows operational cancellations', async () => {
    const capped = vi.fn(async () => {
      throw {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      };
    });
    await expect(
      dynamoScoreStore({ send: capped } as unknown as DynamoDBClient, 'scores').increment(INCREMENT),
    ).resolves.toBe(false);

    const conflict = new Error('transaction conflict');
    Object.assign(conflict, {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'None' }, { Code: 'TransactionConflict' }],
    });
    const failing = vi.fn(async () => {
      throw conflict;
    });
    await expect(
      dynamoScoreStore({ send: failing } as unknown as DynamoDBClient, 'scores').increment(INCREMENT),
    ).rejects.toBe(conflict);
  });
});
