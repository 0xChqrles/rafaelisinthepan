// Conversational ceilings (#236): per group per day, and one global daily model-call
// ceiling, so one group cannot eat the day's budget and one bored participant cannot turn
// the bot into an API loop. Each is a counter row with a TTL, taken with a conditional
// increment — the count may reach the ceiling, never pass it, and two racing takes cannot
// both succeed at it.
//
// NO PER-PERSON CEILING (#277, user-decided 2026-09-09). There was one, charged per
// answered question: reached, it silenced that person for the rest of the day with nothing
// saying why — the third cause found behind "the bot misses messages" — and set high enough
// not to, it never touched the one case it was for. What bounds one person now is the
// exchange budget (`trigger.ts`), which limits only what the bot volunteers.

import {
  ConditionalCheckFailedException,
  UpdateItemCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';

export interface LimitStore {
  // True when the take fit under `max`; false when the ceiling is reached.
  take(scope: string, key: string, max: number, expiresAt: number): Promise<boolean>;
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export const limitKeys = {
  group: (group: string, now: Date) => ({
    scope: `LIMIT#${group}`,
    key: `DAY#${utcDay(now)}#GROUP`,
  }),
  calls: (now: Date) => ({ scope: 'LIMIT#ALL', key: `DAY#${utcDay(now)}#CALLS` }),
};

// Two days: long enough to outlive the UTC day it counts, short enough to vanish on its own.
export function limitExpiry(now: Date): number {
  return Math.floor(now.getTime() / 1000) + 2 * 24 * 60 * 60;
}

export function dynamoLimitStore(client: DynamoDBClient, tableName: string): LimitStore {
  return {
    async take(scope, key, max, expiresAt) {
      if (max <= 0) return false;
      try {
        await client.send(
          new UpdateItemCommand({
            TableName: tableName,
            Key: { pk: { S: scope }, sk: { S: key } },
            UpdateExpression: 'SET #n = if_not_exists(#n, :zero) + :one, #exp = :exp',
            ConditionExpression: 'attribute_not_exists(#n) OR #n < :max',
            ExpressionAttributeNames: { '#n': 'count', '#exp': 'expiresAt' },
            ExpressionAttributeValues: {
              ':zero': { N: '0' },
              ':one': { N: '1' },
              ':max': { N: String(max) },
              ':exp': { N: String(expiresAt) },
            },
          }),
        );
        return true;
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) return false;
        throw error;
      }
    },
  };
}

export function memoryLimitStore(): LimitStore {
  const counts = new Map<string, number>();
  return {
    async take(scope, key, max) {
      const k = `${scope}/${key}`;
      const n = counts.get(k) ?? 0;
      if (n >= max) return false;
      counts.set(k, n + 1);
      return true;
    },
  };
}
