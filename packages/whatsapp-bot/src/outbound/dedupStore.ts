// Sent-command records: `OUTBOX#<group>` / `CMD#<id>` → the WhatsApp message id the send
// returned. Written AFTER the send (see commands.ts for why), read BEFORE it.

import {
  ConditionalCheckFailedException,
  GetItemCommand,
  PutItemCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';

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
      try {
        await client.send(
          new PutItemCommand({
            TableName: tableName,
            Item: {
              ...outboxKey(group, record.commandId),
              waMessageId: { S: record.waMessageId },
              sentAt: { S: record.sentAt },
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
