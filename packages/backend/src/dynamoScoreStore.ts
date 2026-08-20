import {
  BatchGetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  type DynamoDBClient,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import {
  DEDUP_SORT_KEY,
  SCORE_SUBMISSION_LIMIT,
  dayKey,
  dedupKey,
  type ScoreRow,
  type ScoreStore,
} from './scoreStore';

// A batch read that comes back with UnprocessedKeys is DynamoDB saying the partition is
// under pressure. Retrying immediately spends the whole budget inside a few
// milliseconds — before any capacity can come back — which is how a transient throttle
// turns into a 500 on the friends board. So retries wait, with FULL JITTER over a
// doubling window (AWS's own recommendation): the window bounds the wait while the
// randomness keeps Lambdas that were throttled together from returning in lockstep,
// which is the thing that would re-throttle the partition. Worst case here is 5
// attempts over well under a second, comfortably inside the request's own budget.
const BATCH_RETRY_ATTEMPTS = 5;
const BATCH_RETRY_BASE_MS = 50;

export function batchRetryDelayMs(retry: number, random: () => number = Math.random): number {
  return Math.round(random() * BATCH_RETRY_BASE_MS * 2 ** retry);
}

export interface DynamoScoreStoreOptions {
  // Injected by tests, so asserting the retry SCHEDULE costs no real time.
  wait?: (ms: number) => Promise<void>;
}

// DynamoDB's transaction makes the per-IP allowance and the per-player row one
// indivisible write: a refused submission — capped OR already recorded — changes neither
// item. The table uses a composite (`pk`, `sk`) key so one Query returns a daily's whole
// population; no scans or secondary indexes exist.
export function dynamoScoreStore(
  client: DynamoDBClient,
  tableName: string,
  options: DynamoScoreStoreOptions = {},
): ScoreStore {
  const wait = options.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
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
    // Query's own reason (a player opening the board right after their score POST must
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
            // derives it from (not stores) the one-use Turnstile token.
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
                // First write wins (#187): one row per (date, lang, mode, publicId).
                // The daily cannot be replayed, so a second submission never overwrites.
                Put: {
                  TableName: tableName,
                  Item: {
                    pk: { S: dayKey(input) },
                    sk: { S: input.publicId },
                    score: { N: String(input.score) },
                    submittedAt: { S: input.submittedAt },
                  },
                  ConditionExpression: 'attribute_not_exists(pk)',
                },
              },
            ],
          }),
        );
        return 'recorded';
      } catch (error) {
        // Exactly two conditions exist: [0] the IP allowance, [1] the first-write-wins
        // row. Anything else (conflicts, throttling, validation) is operational and must
        // surface/retry rather than silently lose a score. When both fail, the existing
        // row is the truer answer — it is idempotent and consumes nothing.
        const transaction = error as {
          name?: string;
          CancellationReasons?: { Code?: string }[];
        };
        if (transaction.name === 'TransactionCanceledException') {
          const reasons = transaction.CancellationReasons ?? [];
          if (reasons[1]?.Code === 'ConditionalCheckFailed') return 'already_recorded';
          if (reasons[0]?.Code === 'ConditionalCheckFailed') return 'capped';
        }
        throw error;
      }
    },
  };
}
