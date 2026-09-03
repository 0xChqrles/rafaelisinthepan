// The declarations keyspace of the bot table: partition `GROUP#<jid>`, sort
// `DAY#<000000>#PLAYER#<sender>`. Group first because every podium and every stat starts
// from the social group; the day zero-padded into the sort key so ONE range Query answers
// "this group's history between two days" and a `begins_with` answers one day — no GSI.
//
// The write is the precedence rule (`supersedes`) spelled as a ConditionExpression, so two
// replays racing each other cannot interleave into a wrong row: the item is written only if
// none exists, or the incoming message is strictly later, or equal-time with a greater id.

import {
  ConditionalCheckFailedException,
  PutItemCommand,
  QueryCommand,
  type AttributeValue,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import type { Declaration, DeclarationStore } from './declarations';

export function groupPartition(group: string): string {
  return `GROUP#${group}`;
}

// Six digits hold dayNumber (days since 1970) until the year 4707.
export function dayPrefix(dayNumber: number): string {
  return `DAY#${String(dayNumber).padStart(6, '0')}#`;
}

export function declarationSortKey(dayNumber: number, sender: string): string {
  return `${dayPrefix(dayNumber)}PLAYER#${sender}`;
}

function toItem(d: Declaration): Record<string, AttributeValue> {
  return {
    pk: { S: groupPartition(d.group) },
    sk: { S: declarationSortKey(d.dayNumber, d.sender) },
    group: { S: d.group },
    dayNumber: { N: String(d.dayNumber) },
    sender: { S: d.sender },
    score: { N: String(d.score) },
    capped: { BOOL: d.capped },
    token: { S: d.token },
    messageId: { S: d.messageId },
    messageTs: { N: String(d.messageTs) },
    name: { S: d.name },
    receivedAt: { S: d.receivedAt },
    lang: { S: d.lang },
  };
}

export function fromItem(item: Record<string, AttributeValue>): Declaration {
  return {
    group: item.group?.S ?? '',
    dayNumber: Number(item.dayNumber?.N ?? 0),
    sender: item.sender?.S ?? '',
    score: Number(item.score?.N ?? 0),
    capped: item.capped?.BOOL === true,
    token: item.token?.S ?? '',
    messageId: item.messageId?.S ?? '',
    messageTs: Number(item.messageTs?.N ?? 0),
    name: item.name?.S ?? '',
    receivedAt: item.receivedAt?.S ?? '',
    lang: item.lang?.S ?? '',
  };
}

export function dynamoDeclarationStore(
  client: DynamoDBClient,
  tableName: string,
): DeclarationStore {
  async function query(
    pk: string,
    condition: string,
    values: Record<string, AttributeValue>,
  ): Promise<Declaration[]> {
    const rows: Declaration[] = [];
    let cursor: Record<string, AttributeValue> | undefined;
    do {
      const response = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: `#pk = :pk AND ${condition}`,
          ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
          ExpressionAttributeValues: { ':pk': { S: pk }, ...values },
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      );
      for (const item of response.Items ?? []) rows.push(fromItem(item));
      cursor = response.LastEvaluatedKey;
    } while (cursor);
    return rows;
  }

  return {
    async record(declaration) {
      try {
        await client.send(
          new PutItemCommand({
            TableName: tableName,
            Item: toItem(declaration),
            ConditionExpression:
              'attribute_not_exists(#sk) OR #ts < :ts OR (#ts = :ts AND #id < :id)',
            ExpressionAttributeNames: { '#sk': 'sk', '#ts': 'messageTs', '#id': 'messageId' },
            ExpressionAttributeValues: {
              ':ts': { N: String(declaration.messageTs) },
              ':id': { S: declaration.messageId },
            },
          }),
        );
        return 'recorded';
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) return 'unchanged';
        throw error;
      }
    },
    day(group, dayNumber) {
      return query(groupPartition(group), 'begins_with(#sk, :day)', {
        ':day': { S: dayPrefix(dayNumber) },
      });
    },
    range(group, fromDay, toDay) {
      // `DAY#<to>#~` sorts after every `DAY#<to>#PLAYER#…` key ('~' > 'P').
      return query(groupPartition(group), '#sk BETWEEN :from AND :to', {
        ':from': { S: dayPrefix(fromDay) },
        ':to': { S: `${dayPrefix(toDay)}~` },
      });
    },
  };
}
