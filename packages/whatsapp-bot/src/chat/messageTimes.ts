// WHEN A QUOTED MESSAGE WAS SENT. A reply carries the quoted message's id, author and words
// (`QuotedRef`) but not its date, and a WhatsApp id is random (or a hash) with no instant
// in it — so "I never said that" answered with a quote of the bot's line from last week
// read as a quote from nowhere in particular. The task notes the instant of every message
// of a chat-enabled group it sees, its own echoed lines included, and a quote looks its
// id up (`main.ts` `remember`, `dayLog.ts` `quoteLead`).
//
// AN ID AND AN INSTANT, NEVER TEXT: `MSGAT#<group>` / `<message id>`, kept
// `MESSAGE_TIME_TTL_SECONDS` (30 days, the sent record's). The words of an old quote come
// with the reply itself; this row only dates them. A quote of a message older than that,
// or sent before the task first saw it, is simply undated.

import { GetItemCommand, PutItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';

export const MESSAGE_TIME_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface MessageTimes {
  put(group: string, id: string, at: number): Promise<void>;
  // The instant (ms) the message was sent, or null when it was never noted.
  get(group: string, id: string): Promise<number | null>;
}

function key(group: string, id: string) {
  return { pk: { S: `MSGAT#${group}` }, sk: { S: id } };
}

export function dynamoMessageTimes(client: DynamoDBClient, tableName: string): MessageTimes {
  return {
    async put(group, id, at) {
      await client.send(
        new PutItemCommand({
          TableName: tableName,
          Item: {
            ...key(group, id),
            at: { N: String(at) },
            expiresAt: { N: String(Math.floor(at / 1000) + MESSAGE_TIME_TTL_SECONDS) },
          },
        }),
      );
    },
    async get(group, id) {
      const response = await client.send(new GetItemCommand({ TableName: tableName, Key: key(group, id) }));
      const at = response.Item?.at?.N;
      return at === undefined ? null : Number(at);
    },
  };
}

export function memoryMessageTimes(): MessageTimes {
  const rows = new Map<string, number>();
  return {
    async put(group, id, at) {
      rows.set(`${group}#${id}`, at);
    },
    async get(group, id) {
      return rows.get(`${group}#${id}`) ?? null;
    },
  };
}
