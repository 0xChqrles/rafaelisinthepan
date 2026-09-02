import { createHash } from 'node:crypto';
import {
  BatchGetItemCommand,
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  type DynamoDBClient,
  type AttributeValue,
  type TransactWriteItem,
} from '@aws-sdk/client-dynamodb';
import { classifyTransaction, refusedAt } from './dynamoErrors';
import { BATCH_RETRY_ATTEMPTS, batchRetryDelayMs, sleep, type Wait } from './dynamoRetry';
import {
  DEDUP_SORT_KEY,
  SCORE_SUBMISSION_LIMIT,
  dayKey,
  dedupKey,
  type ScoreKey,
  type ScoreRow,
  type ScoreSubmission,
  type ScoreStore,
} from './scoreStore';

// A batch read that comes back with UnprocessedKeys is DynamoDB saying the partition is
// under pressure, and the wait between attempts is the SHARED full-jitter schedule
// (`dynamoRetry.ts`, which holds the reasoning and the numbers).

export interface DynamoScoreStoreOptions {
  // Injected by tests, so asserting the retry SCHEDULE costs no real time.
  wait?: Wait;
}

function scoreItem(input: ScoreSubmission): Record<string, AttributeValue> {
  return {
    pk: { S: dayKey(input) },
    sk: { S: input.publicId },
    score: { N: String(input.score) },
    submittedAt: { S: input.submittedAt },
    revision: { S: input.revision },
    // THE STAMP (#204's adoption model): what the adoption transaction conditions a score
    // row on, instead of on any list of fields. Both writers of a score row build it HERE,
    // so no writer can forget it. It is the submission's own idempotency token — the same
    // logical submission (a replay, a retry) must produce the same item or DynamoDB refuses
    // the reused ClientRequestToken with IdempotentParameterMismatch — and a different
    // revision is a different token, so a replacement changes it.
    stamp: { S: input.requestToken },
  };
}

// The create and replacement transactions are different DynamoDB requests. Their tokens
// must therefore be different too, while still carrying the route token's revision identity.
function replacementToken(requestToken: string): string {
  return createHash('sha256').update(`replace#${requestToken}`).digest('hex').slice(0, 36);
}

// Creating a row and spending its per-IP allowance is one indivisible transaction. A
// republish replaces the existing row with a revision-conditional write and deliberately
// leaves the allowance alone: the population still contains one player. The table uses a
// composite (`pk`, `sk`) key so one Query returns a daily's whole population; no scans or
// secondary indexes exist.
export function dynamoScoreStore(
  client: DynamoDBClient,
  tableName: string,
  options: DynamoScoreStoreOptions = {},
): ScoreStore {
  const wait = options.wait ?? sleep;
  return {
    async list(key) {
      const rows: ScoreRow[] = [];
      let cursor: Record<string, unknown> | undefined;
      do {
        const response = await client.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: '#pk = :pk',
            ExpressionAttributeNames: { '#pk': 'pk' },
            ExpressionAttributeValues: { ':pk': { S: dayKey(key) } },
            // Strong consistency: the POST path reads right after its own committed
            // write, and the returned histogram must already include the caller.
            ConsistentRead: true,
            ...(cursor ? { ExclusiveStartKey: cursor as never } : {}),
          }),
        );
        for (const item of response.Items ?? []) {
          rows.push({ publicId: item.sk?.S ?? '', score: Number(item.score?.N ?? 0) });
        }
        cursor = response.LastEvaluatedKey;
      } while (cursor);
      return rows;
    },

    // The friends board's read: the caller holds the exact sort keys, so this is
    // BatchGetItem — 100 keys a call, constant in the day's population where a
    // partition Query is O(everyone who played today). Strongly consistent for the
    // Query's own reason (a player opening the board right after a solving round write must
    // see their row). UnprocessedKeys are retried; keys still unprocessed after that
    // surface as the operational error they are — silently dropping them would drop a
    // friend's score from the board.
    async getMany(key, publicIds) {
      const pk = dayKey(key);
      const rows: ScoreRow[] = [];
      const ids = [...new Set(publicIds)];
      for (let i = 0; i < ids.length; i += 100) {
        let keys: Record<string, AttributeValue>[] = ids
          .slice(i, i + 100)
          .map((id) => ({ pk: { S: pk }, sk: { S: id } }));
        for (let attempt = 0; keys.length > 0; attempt += 1) {
          if (attempt >= BATCH_RETRY_ATTEMPTS) {
            throw new Error('Score batch read left unprocessed keys.');
          }
          // Only BETWEEN attempts: the first read of a batch is never delayed.
          if (attempt > 0) await wait(batchRetryDelayMs(attempt - 1));
          const response = await client.send(
            new BatchGetItemCommand({
              RequestItems: { [tableName]: { Keys: keys, ConsistentRead: true } },
            }),
          );
          for (const item of response.Responses?.[tableName] ?? []) {
            rows.push({ publicId: item.sk?.S ?? '', score: Number(item.score?.N ?? 0) });
          }
          keys = response.UnprocessedKeys?.[tableName]?.Keys ?? [];
        }
      }
      return rows;
    },

    async submit(input) {
      try {
        await client.send(
          new TransactWriteItemsCommand({
            // Makes an SDK/network retry of this transaction idempotent. The handler
            // derives it from the daily, player and published revision.
            ClientRequestToken: input.requestToken,
            TransactItems: [
              {
                Update: {
                  TableName: tableName,
                  Key: {
                    pk: { S: dedupKey(input, input.ipHash) },
                    sk: { S: DEDUP_SORT_KEY },
                  },
                  UpdateExpression: 'ADD #count :one SET #expiresAt = :expiresAt',
                  ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
                  ExpressionAttributeNames: {
                    '#count': 'count',
                    '#expiresAt': 'expiresAt',
                  },
                  ExpressionAttributeValues: {
                    ':one': { N: '1' },
                    ':limit': { N: String(SCORE_SUBMISSION_LIMIT) },
                    ':expiresAt': { N: String(input.expiresAt) },
                  },
                },
              },
              {
                // This transaction CREATES a player's row only. If it already exists,
                // Dynamo returns it below so the same revision can stop idempotently and a
                // republished revision can replace it without touching the allowance.
                Put: {
                  TableName: tableName,
                  Item: scoreItem(input),
                  ConditionExpression: 'attribute_not_exists(pk)',
                  ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
                },
              },
            ],
          }),
        );
        return 'recorded';
      } catch (error) {
        // Exactly two conditions exist: [0] the IP allowance, [1] row creation. Anything
        // else — a `TransactionConflict`, a throttle, a validation error, a reason carrying
        // no code at all — is OPERATIONAL and surfaces (`dynamoErrors.ts` draws the line;
        // this store keeps its policy of not retrying, since the round route already
        // reports a failed score write rather than failing the append it belongs to).
        const verdict = classifyTransaction(error);
        if (verdict.kind === 'refused') {
          const { reasons } = verdict;
          if (refusedAt(reasons, 1)) {
            const heldRevision = reasons[1].Item?.revision?.S;
            if (heldRevision === input.revision) return 'already_recorded';

            try {
              await client.send(
                new TransactWriteItemsCommand({
                  ClientRequestToken: replacementToken(input.requestToken),
                  TransactItems: [
                    {
                      Put: {
                        TableName: tableName,
                        Item: scoreItem(input),
                        // Replace only a row from another published version. Replaying this
                        // version is idempotent, while an unstamped row is retired like any
                        // other old version.
                        ConditionExpression:
                          'attribute_exists(pk) AND (attribute_not_exists(#rev) OR #rev <> :revision)',
                        ExpressionAttributeNames: { '#rev': 'revision' },
                        ExpressionAttributeValues: { ':revision': { S: input.revision } },
                      },
                    },
                  ],
                }),
              );
              return 'recorded';
            } catch (replacementError) {
              const replacement = classifyTransaction(replacementError);
              if (replacement.kind === 'refused' && refusedAt(replacement.reasons, 0)) {
                // Another request already wrote this version. This request consumed no
                // allowance and changed nothing.
                return 'already_recorded';
              }
              throw replacementError;
            }
          }
          if (refusedAt(reasons, 0)) return 'capped';
        }
        throw error;
      }
    },

    // #204's active-day transfer: the recorded row follows the round it was derived from.
    // ONE transaction — a create-only Put under the adopting account and a Delete of the
    // source — so the day's population holds this score under exactly one player at every
    // instant and the histogram count is never transiently doubled. It spends NO allowance:
    // the population gains no player, it renames the one it has.
  };
}

// #204's active-day transfer, the SCORE half: planned here (the row is this store's shape)
// and committed by `dynamoLinkStore` inside the one adoption transaction, beside the round
// it was derived from — so the day's population holds the score under exactly one player
// at every instant and the histogram count is never transiently doubled.
//
// Called only for a round that MOVES, and it always answers two items, one per row read: a
// move is a create-only Put under the destination and a Delete of the source; a no-move is
// a ConditionCheck on each. Every item asserts the row is unchanged since the read — absent
// still absent, or present at the STAMP it was read with (a row written before stamps
// existed carries none, and asserts that) — so "no row under the source yet" is guarded
// too: the solving append writes the score row a beat after the log, and one landing
// between this read and the commit would otherwise stay under the deleted account.
export async function planScoreMove(
  client: DynamoDBClient,
  tableName: string,
  key: ScoreKey,
  from: string,
  to: string,
): Promise<TransactWriteItem[]> {
  const rowKey = (publicId: string) => ({ pk: { S: dayKey(key) }, sk: { S: publicId } });
  const read = async (publicId: string) => {
    const response = await client.send(
      new GetItemCommand({ TableName: tableName, Key: rowKey(publicId), ConsistentRead: true }),
    );
    return response.Item;
  };
  const unchanged = (item: Record<string, AttributeValue> | undefined) => {
    if (!item) return { ConditionExpression: 'attribute_not_exists(pk)' };
    const stamp = item.stamp?.S;
    if (stamp === undefined) {
      return {
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(#stamp)',
        ExpressionAttributeNames: { '#stamp': 'stamp' },
      };
    }
    return {
      ConditionExpression: '#stamp = :stamp',
      ExpressionAttributeNames: { '#stamp': 'stamp' },
      ExpressionAttributeValues: { ':stamp': { S: stamp } },
    };
  };
  const [source, destination] = await Promise.all([read(from), read(to)]);
  if (!source || destination) {
    return [
      { ConditionCheck: { TableName: tableName, Key: rowKey(from), ...unchanged(source) } },
      { ConditionCheck: { TableName: tableName, Key: rowKey(to), ...unchanged(destination) } },
    ];
  }
  return [
    {
      Put: {
        TableName: tableName,
        Item: { ...source, ...rowKey(to) },
        ...unchanged(destination),
      },
    },
    {
      Delete: {
        TableName: tableName,
        Key: rowKey(from),
        ...unchanged(source),
      },
    },
  ];
}
