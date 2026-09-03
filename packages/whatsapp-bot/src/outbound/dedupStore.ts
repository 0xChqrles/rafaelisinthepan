// Sent-command records: `OUTBOX#<group>` / `CMD#<id>` → the WhatsApp message id the send
// returned. Written AFTER the send (see commands.ts for why), read BEFORE it.

import {
  ConditionalCheckFailedException,
  GetItemCommand,
  PutItemCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';

// The record's only job is to catch a REDELIVERY — an SQS retry, a replayed podium
// invocation, a task that restarted mid-batch — and every one of those happens within days
// (the queue's own retention is four). So it is transient material and wears the table's
// TTL, instead of accumulating one permanent row per message the bot has ever sent.
export const SENT_RECORD_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface SentRecord {
  commandId: string;
  waMessageId: string;
  sentAt: string;
}

export interface SentStore {
  get(group: string, commandId: string): Promise<SentRecord | null>;
  // First write wins; a second record of the same command is left as it was.
  put(group: string, record: SentRecord): Promise<void>;
}

export function outboxKey(group: string, commandId: string) {
  return { pk: { S: `OUTBOX#${group}` }, sk: { S: `CMD#${commandId}` } };
}

export function dynamoSentStore(client: DynamoDBClient, tableName: string): SentStore {
  return {
    async get(group, commandId) {
      const response = await client.send(
        new GetItemCommand({ TableName: tableName, Key: outboxKey(group, commandId) }),
      );
      const item = response.Item;
      if (!item) return null;
      return {
        commandId,
        waMessageId: item.waMessageId?.S ?? '',
        sentAt: item.sentAt?.S ?? '',
      };
    },
    async put(group, record) {
      // A malformed instant must not become the string "NaN" in a Number attribute, which
      // DynamoDB refuses — the row would be lost and the command could send twice.
      const sentAtMs = Date.parse(record.sentAt);
      const from = Number.isFinite(sentAtMs) ? sentAtMs : Date.now();
      try {
        await client.send(
          new PutItemCommand({
            TableName: tableName,
            Item: {
              ...outboxKey(group, record.commandId),
              waMessageId: { S: record.waMessageId },
              sentAt: { S: record.sentAt },
              expiresAt: { N: String(Math.floor(from / 1000) + SENT_RECORD_TTL_SECONDS) },
            },
            ConditionExpression: 'attribute_not_exists(#sk)',
            ExpressionAttributeNames: { '#sk': 'sk' },
          }),
        );
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) throw error;
      }
    },
  };
}

export function memorySentStore(): SentStore {
  const rows = new Map<string, SentRecord>();
  return {
    async get(group, commandId) {
      return rows.get(`${group}#${commandId}`) ?? null;
    },
    async put(group, record) {
      const key = `${group}#${record.commandId}`;
      if (!rows.has(key)) rows.set(key, record);
    },
  };
}
