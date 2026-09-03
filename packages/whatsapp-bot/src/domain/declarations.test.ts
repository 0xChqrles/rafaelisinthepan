import { describe, expect, it, vi } from 'vitest';
import {
  ConditionalCheckFailedException,
  PutItemCommand,
  QueryCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  memoryDeclarationStore,
  ownEarlierAttempt,
  playersIn,
  supersedes,
  type Declaration,
} from './declarations';
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

  it('a same-token re-share moves the row to the later message but is UNCHANGED', async () => {
    const store = memoryDeclarationStore();
    expect(await store.record(base)).toBe('recorded');
    expect(await store.record({ ...base, messageId: 'M2', messageTs: 1_001, name: 'Gab 🔥' })).toBe(
      'unchanged',
    );
    // The bookkeeping follows the latest message — which is what keeps a replay
    // convergent — while the outcome says nothing material happened.
    expect((await store.day(base.group, base.dayNumber))[0]).toMatchObject({
      token: 'AAA',
      messageId: 'M2',
      name: 'Gab 🔥',
    });
    // The convergence case that ignoring the same-token message would break: A(X) C(Y)
    // B(X, latest) arriving as A, B, C must end on X, the player's latest statement.
    const other = memoryDeclarationStore();
    await other.record(base); // A: X at 1000
    await other.record({ ...base, messageId: 'B', messageTs: 1_002 }); // B: X at 1002
    expect(await other.record({ ...base, token: 'YYY', messageId: 'C', messageTs: 1_001 })).toBe(
      'unchanged',
    );
    expect((await other.day(base.group, base.dayNumber))[0].token).toBe('AAA');
  });

  it('a retry of its OWN lost write is recorded; a second delivery is the no-op', async () => {
    const later = { ...base, receivedAt: '2026-09-03T10:00:05.000Z' };
    expect(ownEarlierAttempt(undefined, base)).toBe(false);
    expect(ownEarlierAttempt(base, base)).toBe(true);
    expect(ownEarlierAttempt(base, later)).toBe(false);
    expect(ownEarlierAttempt(base, { ...base, messageId: 'M2' })).toBe(false);

    const store = memoryDeclarationStore();
    expect(await store.record(base)).toBe('recorded');
    // The same ingest call sending the same declaration again: its first write landed and
    // the answer was lost. Refused by its own row, and told so.
    expect(await store.record(base)).toBe('recorded');
    // The same MESSAGE arriving again in a later call (a replay, a duplicate delivery).
    expect(await store.record(later)).toBe('unchanged');
    expect((await store.day(base.group, base.dayNumber))[0].receivedAt).toBe(base.receivedAt);
  });

  it('the memory store applies it and answers day + range reads in order', async () => {
    const store = memoryDeclarationStore();
    expect(await store.record(base)).toBe('recorded');
    expect(await store.record({ ...base, receivedAt: '2026-09-03T10:00:05.000Z' })).toBe('unchanged');
    expect(
      await store.record({ ...base, score: 4, token: 'BBB', messageId: 'M2', messageTs: 1_001 }),
    ).toBe('recorded');
    expect(
      await store.record({ ...base, score: 3, token: 'CCC', messageId: 'M0', messageTs: 900 }),
    ).toBe('unchanged');
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
    expect(put.input.ReturnValues).toBe('ALL_OLD');
    expect(put.input.ReturnValuesOnConditionCheckFailure).toBe('ALL_OLD');
    expect(put.input.Item?.pk).toEqual({ S: `GROUP#${base.group}` });
    expect(fromItem(put.input.Item!)).toEqual(base);
  });

  it('reads the token it DISPLACED to tell a re-share from a replacement', async () => {
    const send = vi.fn(async () => ({ Attributes: { token: { S: 'AAA' } } }));
    const store = dynamoDeclarationStore({ send } as unknown as DynamoDBClient, 'bot');
    expect(await store.record({ ...base, messageId: 'M2', messageTs: 1_001 })).toBe('unchanged');
    expect(await store.record({ ...base, token: 'BBB', messageId: 'M3', messageTs: 1_002 })).toBe(
      'recorded',
    );
  });

  it('recognises its own earlier attempt in the row a refused write hands back', async () => {
    const standing = { messageId: { S: base.messageId }, receivedAt: { S: base.receivedAt } };
    const send = vi.fn(async () => {
      throw new ConditionalCheckFailedException({ message: 'refused', $metadata: {}, Item: standing });
    });
    const store = dynamoDeclarationStore({ send } as unknown as DynamoDBClient, 'bot');
    expect(await store.record(base)).toBe('recorded');
    expect(await store.record({ ...base, receivedAt: '2026-09-03T10:00:05.000Z' })).toBe('unchanged');
    expect(await store.record({ ...base, messageId: 'M0', messageTs: 900 })).toBe('unchanged');
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
