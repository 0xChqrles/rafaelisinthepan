import {
  GetItemCommand,
  TransactWriteItemsCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  SCORE_SUBMISSION_LIMIT,
  aggregateKey,
  dedupKey,
  type ScoreStore,
} from './scoreStore';

// DynamoDB's transaction makes the per-IP allowance and the aggregate counter one
// indivisible write: a capped request changes neither item, and a successful request
// changes both. The table uses one string partition key (`pk`) because every item is
// fetched or updated directly; no scans or secondary indexes exist.
export function dynamoScoreStore(client: DynamoDBClient, tableName: string): ScoreStore {
  return {
    async get(key, bucketCount) {
      const response = await client.send(
        new GetItemCommand({
          TableName: tableName,
          Key: { pk: { S: aggregateKey(key) } },
          ConsistentRead: true,
        }),
      );
      return {
        buckets: Array.from({ length: bucketCount }, (_unused, index) =>
          Number(response.Item?.[`b${index}`]?.N ?? 0),
        ),
        total: Number(response.Item?.total?.N ?? 0),
      };
    },

    async increment(input) {
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
                  Key: { pk: { S: dedupKey(input, input.ipHash) } },
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
                Update: {
                  TableName: tableName,
                  Key: { pk: { S: aggregateKey(input) } },
                  UpdateExpression: 'ADD #bucket :one, #total :one',
                  ExpressionAttributeNames: {
                    '#bucket': `b${input.bucket}`,
                    '#total': 'total',
                  },
                  ExpressionAttributeValues: { ':one': { N: '1' } },
                },
              },
            ],
          }),
        );
        return true;
      } catch (error) {
        // This transaction has exactly one condition, on the first item. Do not flatten
        // other transaction failures (conflicts, throttling, validation) into a cap: they
        // are operational errors and must surface/retry rather than silently lose a score.
        const transaction = error as {
          name?: string;
          CancellationReasons?: { Code?: string }[];
        };
        if (
          transaction.name === 'TransactionCanceledException' &&
          transaction.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
        ) {
          return false;
        }
        throw error;
      }
    },
  };
}
