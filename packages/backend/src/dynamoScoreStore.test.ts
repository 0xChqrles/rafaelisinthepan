import { describe, expect, it, vi } from 'vitest';
import {
  BatchGetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { batchRetryDelayMs, dynamoScoreStore } from './dynamoScoreStore';
import { SCORE_SUBMISSION_LIMIT, type ScoreKey, type ScoreSubmission } from './scoreStore';

const KEY: ScoreKey = { date: '2026-08-13', lang: 'fr', mode: 'word' };
const SUBMISSION: ScoreSubmission = {
  ...KEY,
  publicId: 'lfd5pqz5pa7zjm5u',
  score: 12,
  submittedAt: '2026-08-13T14:00:00.000Z',
  ipHash: 'abcdef0123456789',
  expiresAt: 1_800_000_000,
  requestToken: '0123456789abcdef0123456789abcdef0123',
};

describe('dynamoScoreStore (#187)', () => {
  it('reads the whole day partition consistently, following pagination', async () => {
    const pages = [
      {
        Items: [{ sk: { S: 'player-a' }, score: { N: '4' } }],
        LastEvaluatedKey: { pk: { S: 'cursor' } },
      },
      { Items: [{ sk: { S: 'player-b' }, score: { N: '9' } }] },
    ];
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(QueryCommand);
      return pages.shift()!;
    });
    const store = dynamoScoreStore({ send } as unknown as DynamoDBClient, 'scores');
    await expect(store.list(KEY)).resolves.toEqual([
      { publicId: 'player-a', score: 4 },
      { publicId: 'player-b', score: 9 },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    const first = (send.mock.calls[0][0] as QueryCommand).input;
    expect(first).toMatchObject({
      TableName: 'scores',
      ConsistentRead: true,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeValues: { ':pk': { S: 'score#2026-08-13#fr#word' } },
    });
    expect(first.ExclusiveStartKey).toBeUndefined();
    const second = (send.mock.calls[1][0] as QueryCommand).input;
    expect(second.ExclusiveStartKey).toEqual({ pk: { S: 'cursor' } });
  });

  it('reads a KNOWN key set in batches, retrying what came back unprocessed (#190)', async () => {
    // The friends board holds the exact sort keys, so it must never page the day
    // partition to keep at most FRIENDS_MAX + 1 rows. Two contracts here: the read is
    // batched and consistent, and an UNPROCESSED key is retried rather than silently
    // dropped — a dropped key is a friend's score missing from the board.
    const responses = [
      {
        Responses: { scores: [{ sk: { S: 'player-a' }, score: { N: '4' } }] },
        UnprocessedKeys: { scores: { Keys: [{ pk: { S: 'p' }, sk: { S: 'player-b' } }] } },
      },
      { Responses: { scores: [{ sk: { S: 'player-b' }, score: { N: '9' } }] } },
    ];
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(BatchGetItemCommand);
      return responses.shift()!;
    });
    const store = dynamoScoreStore({ send } as unknown as DynamoDBClient, 'scores');
    // The duplicate is collapsed; a player with no row today simply has none.
    await expect(
      store.getMany(KEY, ['player-a', 'player-b', 'player-a', 'never-played']),
    ).resolves.toEqual([
      { publicId: 'player-a', score: 4 },
      { publicId: 'player-b', score: 9 },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    const first = (send.mock.calls[0][0] as BatchGetItemCommand).input;
    expect(first.RequestItems?.scores).toMatchObject({ ConsistentRead: true });
    expect(first.RequestItems?.scores.Keys).toEqual([
      { pk: { S: 'score#2026-08-13#fr#word' }, sk: { S: 'player-a' } },
      { pk: { S: 'score#2026-08-13#fr#word' }, sk: { S: 'player-b' } },
      { pk: { S: 'score#2026-08-13#fr#word' }, sk: { S: 'never-played' } },
    ]);
  });

  it('gives up loudly when a batch never drains, rather than dropping rows', async () => {
    const send = vi.fn(async () => ({
      Responses: { scores: [] },
      UnprocessedKeys: { scores: { Keys: [{ pk: { S: 'p' }, sk: { S: 'player-a' } }] } },
    }));
    const waits: number[] = [];
    const store = dynamoScoreStore({ send } as unknown as DynamoDBClient, 'scores', {
      wait: async (ms) => {
        waits.push(ms);
      },
    });
    await expect(store.getMany(KEY, ['player-a'])).rejects.toThrow(/unprocessed/i);
    // BACKS OFF between attempts, never before the first: retrying a throttled
    // partition at full speed spends the whole budget before capacity can return.
    expect(send).toHaveBeenCalledTimes(5);
    expect(waits).toHaveLength(4);
  });

  it('waits a full-jitter doubling window between batch retries', () => {
    // Full jitter: each retry draws from [0, base * 2^n], so the CEILING doubles while
    // the actual wait stays random — Lambdas throttled together must not come back in
    // lockstep and re-throttle the partition.
    const ceilings = [0, 1, 2, 3].map((retry) => batchRetryDelayMs(retry, () => 1));
    expect(ceilings).toEqual([50, 100, 200, 400]);
    // The draw is the whole window, floor included.
    expect([0, 1, 2, 3].map((retry) => batchRetryDelayMs(retry, () => 0))).toEqual([0, 0, 0, 0]);
    const middle = [0, 1, 2, 3].map((retry) => batchRetryDelayMs(retry, () => 0.5));
    expect(middle).toEqual([25, 50, 100, 200]);
  });

  it('atomically writes the capped dedup item and the first-write-wins row in one transaction', async () => {
    const send = vi.fn(async (_command: unknown) => ({}));
    const store = dynamoScoreStore({ send } as unknown as DynamoDBClient, 'scores');
    await expect(store.submit(SUBMISSION)).resolves.toBe('recorded');

    const command = send.mock.calls[0][0] as TransactWriteItemsCommand;
    expect(command).toBeInstanceOf(TransactWriteItemsCommand);
    expect(command.input.ClientRequestToken).toBe(SUBMISSION.requestToken);
    expect(command.input.TransactItems).toHaveLength(2);
    const [dedup, row] = command.input.TransactItems!;
    expect(dedup.Update).toMatchObject({
      TableName: 'scores',
      Key: {
        pk: { S: `dedup#2026-08-13#fr#word#${SUBMISSION.ipHash}` },
        sk: { S: 'dedup' },
      },
      ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
      ExpressionAttributeValues: {
        ':limit': { N: String(SCORE_SUBMISSION_LIMIT) },
        ':expiresAt': { N: String(SUBMISSION.expiresAt) },
      },
    });
    expect(row.Put).toMatchObject({
      TableName: 'scores',
      Item: {
        pk: { S: 'score#2026-08-13#fr#word' },
        sk: { S: SUBMISSION.publicId },
        score: { N: '12' },
        submittedAt: { S: SUBMISSION.submittedAt },
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('maps each condition failure to its outcome and rethrows operational cancellations', async () => {
    const outcomes: Array<[reasons: { Code?: string }[], expected: string]> = [
      // The IP allowance is exhausted; the row condition never evaluated against a row.
      [[{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }], 'capped'],
      // The player already has a row: first write wins, no allowance consumed.
      [[{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }], 'already_recorded'],
      // Both failed: the existing row is the truer, idempotent answer.
      [[{ Code: 'ConditionalCheckFailed' }, { Code: 'ConditionalCheckFailed' }], 'already_recorded'],
    ];
    for (const [reasons, expected] of outcomes) {
      const send = vi.fn(async () => {
        throw { name: 'TransactionCanceledException', CancellationReasons: reasons };
      });
      await expect(
        dynamoScoreStore({ send } as unknown as DynamoDBClient, 'scores').submit(SUBMISSION),
      ).resolves.toBe(expected);
    }

    const conflict = new Error('transaction conflict');
    Object.assign(conflict, {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'None' }, { Code: 'TransactionConflict' }],
    });
    const failing = vi.fn(async () => {
      throw conflict;
    });
    await expect(
      dynamoScoreStore({ send: failing } as unknown as DynamoDBClient, 'scores').submit(SUBMISSION),
    ).rejects.toBe(conflict);
  });
});
