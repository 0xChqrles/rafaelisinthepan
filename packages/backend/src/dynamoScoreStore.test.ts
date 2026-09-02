import { describe, expect, it, vi } from 'vitest';
import {
  BatchGetItemCommand,
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  type DynamoDBClient,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { batchRetryDelayMs, dynamoScoreStore, planScoreMove } from './dynamoScoreStore';
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

// CONTRACT (#204): the recorded row follows the round it was derived from, inside the one
// adoption transaction — this store only PLANS its items, two per tuple, one per row read,
// each asserting the row is unchanged since the read: absent still absent, or at the STAMP
// it carried. The stamp is DETERMINISTIC for one logical submission — it is the
// submission's own idempotency token — because a replay that produced a different item
// under a reused ClientRequestToken is an IdempotentParameterMismatch, not a no-op.
describe('the score stamp (#204)', () => {
  it('is the same for the same logical submission and different for a different revision', async () => {
    const puts: Record<string, AttributeValue>[] = [];
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof TransactWriteItemsCommand) {
        for (const item of command.input.TransactItems ?? []) {
          if (item.Put?.Item?.sk?.S === SUBMISSION.publicId) puts.push(item.Put.Item);
        }
      }
      return {};
    });
    const store = dynamoScoreStore({ send } as unknown as DynamoDBClient, 'scores');
    await store.submit(SUBMISSION);
    await store.submit(SUBMISSION);
    await store.submit({ ...SUBMISSION, revision: 'rev2', requestToken: 'another-token-000000000000000000' });
    expect(puts).toHaveLength(3);
    expect(puts[0].stamp).toEqual({ S: SUBMISSION.requestToken });
    expect(puts[1]).toEqual(puts[0]);
    expect(puts[2].stamp).toEqual({ S: 'another-token-000000000000000000' });
  });
});

describe('planScoreMove (#204)', () => {
  const FROM = 'aaaaaaaaaaaaaaaa';
  const TO = 'bbbbbbbbbbbbbbbb';
  const at = (publicId: string) => ({ pk: { S: 'score#2026-08-13#fr#word' }, sk: { S: publicId } });
  const row = {
    ...at(FROM),
    score: { N: '7' },
    submittedAt: { S: '2026-08-13T10:00:00.000Z' },
    revision: { S: 'rev1' },
    stamp: { S: 'stamp-from' },
  };
  const targetRow = { ...at(TO), score: { N: '3' }, revision: { S: 'rev1' }, stamp: { S: 'stamp-to' } };
  const plan = (rows: { from?: Record<string, AttributeValue>; to?: Record<string, AttributeValue> }) =>
    planScoreMove(
      {
        send: async (command: unknown) =>
          ({ Item: (command as GetItemCommand).input.Key!.sk.S === FROM ? rows.from : rows.to }),
      } as unknown as DynamoDBClient,
      'scores',
      KEY,
      FROM,
      TO,
    );

  it('moves: a create-only Put under the destination and a Delete of the source AT ITS STAMP', async () => {
    const items = await plan({ from: row });
    expect(items).toHaveLength(2);
    expect(items[0].Put).toMatchObject({
      Item: { ...row, ...at(TO) },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    // The row as READ, never mere existence: a revision replacement landing meanwhile
    // changes the stamp and must refuse the commit rather than be overwritten.
    expect(items[1].Delete).toMatchObject({
      Key: at(FROM),
      ConditionExpression: '#stamp = :stamp',
      ExpressionAttributeValues: { ':stamp': { S: 'stamp-from' } },
    });
  });

  for (const [label, to] of [
    ['absent', undefined],
    ['present', targetRow],
  ] as const) {
    it(`guards BOTH rows on a no-move — no source row yet, destination ${label}`, async () => {
      // The solving append writes the score row a beat after the log, so "no row yet" is
      // exactly the observation a concurrent write can invalidate.
      const items = await plan({ to });
      expect(items).toHaveLength(2);
      expect(items[0].ConditionCheck).toMatchObject({
        Key: at(FROM),
        ConditionExpression: 'attribute_not_exists(pk)',
      });
      expect(items[1].ConditionCheck).toMatchObject({
        Key: at(TO),
        ConditionExpression: to ? '#stamp = :stamp' : 'attribute_not_exists(pk)',
      });
    });
  }

  it('guards BOTH rows when the destination already has a row', async () => {
    const items = await plan({ from: row, to: targetRow });
    expect(items).toHaveLength(2);
    expect(items[0].ConditionCheck).toMatchObject({
      Key: at(FROM),
      ExpressionAttributeValues: { ':stamp': { S: 'stamp-from' } },
    });
    expect(items[1].ConditionCheck).toMatchObject({
      Key: at(TO),
      ExpressionAttributeValues: { ':stamp': { S: 'stamp-to' } },
    });
  });

  it('reads a row with no stamp as an observed state of its own', async () => {
    const { stamp: _stamp, ...unstamped } = row;
    const items = await plan({ from: unstamped });
    expect(items[1].Delete!.ConditionExpression).toBe(
      'attribute_exists(pk) AND attribute_not_exists(#stamp)',
    );
  });
});
