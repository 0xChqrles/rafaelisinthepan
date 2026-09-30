import {
  BatchGetItemCommand,
  type AttributeValue,
  type DynamoDBClient,
  type KeysAndAttributes,
} from '@aws-sdk/client-dynamodb';
import { BATCH_RETRY_ATTEMPTS, batchRetryDelayMs, type Wait } from './dynamoRetry';

// DynamoDB's own limit on one BatchGetItem call.
const BATCH_GET_MAX_KEYS = 100;

// The read of a KNOWN key set, for the stores whose caller holds the exact row keys: 100
// keys a call, and whatever a call leaves in `UnprocessedKeys` is asked again behind the
// shared full-jitter schedule (`dynamoRetry.ts`, which holds the reasoning and the numbers).
// Keys still unprocessed after the last attempt surface as the operational error they are —
// silently dropping them would drop rows from whatever the caller is building. `request`
// is what differs per store (the consistency, a projection); `label` names the store in
// that error. It lives apart from the schedule so that module stays free of the SDK.
export async function batchGetAll(
  client: DynamoDBClient,
  tableName: string,
  keys: readonly Record<string, AttributeValue>[],
  request: Omit<KeysAndAttributes, 'Keys'>,
  wait: Wait,
  label: string,
): Promise<Record<string, AttributeValue>[]> {
  const items: Record<string, AttributeValue>[] = [];
  for (let i = 0; i < keys.length; i += BATCH_GET_MAX_KEYS) {
    let pending = keys.slice(i, i + BATCH_GET_MAX_KEYS);
    for (let attempt = 0; pending.length > 0; attempt += 1) {
      if (attempt >= BATCH_RETRY_ATTEMPTS) {
        throw new Error(`${label} batch read left unprocessed keys.`);
      }
      // Only BETWEEN attempts: the first read of a batch is never delayed.
      if (attempt > 0) await wait(batchRetryDelayMs(attempt - 1));
      const response = await client.send(
        new BatchGetItemCommand({
          RequestItems: { [tableName]: { Keys: pending, ...request } },
        }),
      );
      items.push(...(response.Responses?.[tableName] ?? []));
      pending = response.UnprocessedKeys?.[tableName]?.Keys ?? [];
    }
  }
  return items;
}
