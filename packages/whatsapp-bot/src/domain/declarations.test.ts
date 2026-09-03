import { describe, expect, it, vi } from 'vitest';
import {
  ConditionalCheckFailedException,
  PutItemCommand,
  QueryCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { memoryDeclarationStore, playersIn, supersedes, type Declaration } from './declarations';
import { dynamoDeclarationStore, declarationSortKey, fromItem } from './dynamoDeclarationStore';

const base: Declaration = {
  group: '120363000000000001@g.us',
  dayNumber: 20700,
  sender: '33612345678@s.whatsapp.net',
  score: 7,
  capped: false,
  token: 'AAA',
  messageId: 'M1',
  messageTs: 1_000,
  name: 'Gab',
  receivedAt: '2026-09-03T10:00:00.000Z',
  lang: 'fr',
};

describe('declaration precedence (#236)', () => {
  it('a later message replaces, the same message is a no-op, an older one is ignored', () => {
    expect(supersedes(undefined, base)).toBe(true);
    expect(supersedes(base, base)).toBe(false);
    expect(supersedes(base, { messageTs: 999, messageId: 'M9' })).toBe(false);
    expect(supersedes(base, { messageTs: 1_001, messageId: 'M0' })).toBe(true);
  });

  it('breaks an exact timestamp tie by message id, stably', () => {
    expect(supersedes(base, { messageTs: 1_000, messageId: 'M2' })).toBe(true);
    expect(supersedes({ messageTs: 1_000, messageId: 'M2' }, base)).toBe(false);
  });

  it('the memory store applies it and answers day + range reads in order', async () => {
    const store = memoryDeclarationStore();
    expect(await store.record(base)).toBe('recorded');
    expect(await store.record(base)).toBe('unchanged');
    expect(await store.record({ ...base, score: 4, messageId: 'M2', messageTs: 1_001 })).toBe(
      'recorded',
    );
    expect(await store.record({ ...base, score: 3, messageId: 'M0', messageTs: 900 })).toBe(
      'unchanged',
    );
    await store.record({ ...base, sender: '33600000000@s.whatsapp.net', name: 'Zou', score: 5 });
    await store.record({ ...base, dayNumber: 20701, score: 9 });
    const day = await store.day(base.group, 20700);
    expect(day.map((r) => [r.name, r.score])).toEqual([
      ['Zou', 5],
      ['Gab', 4],
    ]);
    expect((await store.range(base.group, 20700, 20701)).map((r) => r.dayNumber)).toEqual([
      20700, 20700, 20701,
    ]);
    expect(await store.day('120363000000000002@g.us', 20700)).toEqual([]);
  });

  it('lists the players a window has seen with their latest name snapshot', () => {
    const players = playersIn([
      base,
      { ...base, dayNumber: 20701, name: 'Gab 🔥' },
      { ...base, sender: '33600000000@s.whatsapp.net', name: 'Zou' },
    ]);
    expect(players.map((p) => p.name)).toEqual(['Zou', 'Gab 🔥']);
  });
});

describe('DynamoDB declaration keyspace', () => {
  it('sorts days lexically and spells the precedence rule as the write condition', async () => {
    expect(declarationSortKey(20700, 'x@s.whatsapp.net')).toBe('DAY#020700#PLAYER#x@s.whatsapp.net');
    expect(declarationSortKey(20700, 'a') < declarationSortKey(20701, 'a')).toBe(true);

    const send = vi.fn(async () => ({}));
    const store = dynamoDeclarationStore({ send } as unknown as DynamoDBClient, 'bot');
    expect(await store.record(base)).toBe('recorded');
    const put = (send.mock.calls[0] as unknown[])[0] as PutItemCommand;
    expect(put.input.ConditionExpression).toBe(
      'attribute_not_exists(#sk) OR #ts < :ts OR (#ts = :ts AND #id < :id)',
    );
    expect(put.input.Item?.pk).toEqual({ S: `GROUP#${base.group}` });
    expect(fromItem(put.input.Item!)).toEqual(base);
  });

  it('reads a refused condition as unchanged and pages a range query', async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof PutItemCommand) {
        throw new ConditionalCheckFailedException({ message: 'refused', $metadata: {} });
      }
      const query = command as QueryCommand;
      if (!query.input.ExclusiveStartKey) {
        return { Items: [], LastEvaluatedKey: { pk: { S: 'x' }, sk: { S: 'y' } } };
      }
      return { Items: [] };
    });
    const store = dynamoDeclarationStore({ send } as unknown as DynamoDBClient, 'bot');
    expect(await store.record(base)).toBe('unchanged');
    await store.range(base.group, 20690, 20700);
    const first = (send.mock.calls[1] as unknown[])[0] as QueryCommand;
    expect(first.input.KeyConditionExpression).toBe('#pk = :pk AND #sk BETWEEN :from AND :to');
    expect(first.input.ExpressionAttributeValues?.[':from']).toEqual({ S: 'DAY#020690#' });
    expect(send).toHaveBeenCalledTimes(3);
  });
});
