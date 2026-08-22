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
  revision: 'a1b2c3d4e5f60718',
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

  it('atomically spends the allowance only when it creates a player row', async () => {
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
        // The PUBLISHED VERSION this score was earned on (#203): first-write-wins is per
        // version, so a corrected puzzle's score is not blocked by the retired one's.
        revision: { S: SUBMISSION.revision },
      },
      ConditionExpression: 'attribute_not_exists(pk)',
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    });
  });

  it('replaces a retired revision without spending a capped allowance', async () => {
    let call = 0;
    const send = vi.fn(async (_command: unknown) => {
      call += 1;
      if (call === 1) {
        throw {
          name: 'TransactionCanceledException',
          CancellationReasons: [
            { Code: 'ConditionalCheckFailed' },
            {
              Code: 'ConditionalCheckFailed',
              Item: {
                pk: { S: 'score#2026-08-13#fr#word' },
                sk: { S: SUBMISSION.publicId },
                revision: { S: 'retired-revision' },
              },
            },
          ],
        };
      }
      return {};
    });
    const store = dynamoScoreStore({ send } as unknown as DynamoDBClient, 'scores');
    await expect(store.submit(SUBMISSION)).resolves.toBe('recorded');
    expect(send).toHaveBeenCalledTimes(2);

    const create = send.mock.calls[0][0] as TransactWriteItemsCommand;
    const replacement = send.mock.calls[1][0] as TransactWriteItemsCommand;
    expect(replacement).toBeInstanceOf(TransactWriteItemsCommand);
    expect(replacement.input.ClientRequestToken).not.toBe(create.input.ClientRequestToken);
    expect(replacement.input.ClientRequestToken).toHaveLength(36);
    expect(replacement.input.TransactItems).toHaveLength(1);
    expect(replacement.input.TransactItems?.[0].Put).toMatchObject({
      Item: {
        score: { N: '12' },
        revision: { S: SUBMISSION.revision },
      },
      ConditionExpression:
        'attribute_exists(pk) AND (attribute_not_exists(#rev) OR #rev <> :revision)',
      ExpressionAttributeValues: { ':revision': { S: SUBMISSION.revision } },
    });
    // The replacement transaction contains no dedup update: the population still has
    // exactly one row for this player.
    expect(replacement.input.TransactItems?.[0].Update).toBeUndefined();
  });

  it('keeps a replacement idempotent when another request writes it first', async () => {
    let call = 0;
    const send = vi.fn(async (_command: unknown) => {
      call += 1;
      if (call === 1) {
        throw {
          name: 'TransactionCanceledException',
          CancellationReasons: [
            { Code: 'None' },
            {
              Code: 'ConditionalCheckFailed',
              Item: {
                pk: { S: 'score#2026-08-13#fr#word' },
                sk: { S: SUBMISSION.publicId },
              },
            },
          ],
        };
      }
      throw {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      };
    });
    const store = dynamoScoreStore({ send } as unknown as DynamoDBClient, 'scores');
    // A concurrent request wrote this version between create and replacement. This one
    // changes no row and spends no allowance.
    await expect(store.submit(SUBMISSION)).resolves.toBe('already_recorded');
    const replacement = send.mock.calls[1][0] as TransactWriteItemsCommand;
    expect(replacement.input.TransactItems?.[0].Put).toMatchObject({
      ConditionExpression:
        'attribute_exists(pk) AND (attribute_not_exists(#rev) OR #rev <> :revision)',
      ExpressionAttributeValues: { ':revision': { S: SUBMISSION.revision } },
    });
  });

  it('maps same-version and cap failures without mutating either item', async () => {
    const sameVersion = vi.fn(async () => {
      throw {
        name: 'TransactionCanceledException',
        CancellationReasons: [
          { Code: 'ConditionalCheckFailed' },
          {
            Code: 'ConditionalCheckFailed',
            Item: { revision: { S: SUBMISSION.revision } },
          },
        ],
      };
    });
    await expect(
      dynamoScoreStore({ send: sameVersion } as unknown as DynamoDBClient, 'scores').submit(
        SUBMISSION,
      ),
    ).resolves.toBe('already_recorded');
    expect(sameVersion).toHaveBeenCalledTimes(1);

    const capped = vi.fn(async () => {
      throw {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      };
    });
    await expect(
      dynamoScoreStore({ send: capped } as unknown as DynamoDBClient, 'scores').submit(SUBMISSION),
    ).resolves.toBe('capped');
    expect(capped).toHaveBeenCalledTimes(1);
  });

  it('rethrows operational cancellations', async () => {
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
