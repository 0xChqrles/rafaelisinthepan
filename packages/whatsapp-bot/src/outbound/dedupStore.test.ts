import { describe, expect, it, vi } from 'vitest';
import { GetItemCommand, PutItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SENT_RECORD_TTL_SECONDS, dynamoSentStore, memorySentStore } from './dedupStore';

const GROUP = '120363000000000001@g.us';
const SENT_AT = '2026-09-03T12:00:00.000Z';

function record(over: Partial<Parameters<ReturnType<typeof memorySentStore>['put']>[1]> = {}) {
  return { commandId: `podium:${GROUP}:20700`, waMessageId: 'WA1', sentAt: SENT_AT, ...over };
}

describe('sent-command records (#236)', () => {
  it('writes first-wins, with a TTL taken from the send instant', async () => {
    const send = vi.fn(async () => ({}));
    const store = dynamoSentStore({ send } as unknown as DynamoDBClient, 'bot');
    await store.put(GROUP, record());
    const put = (send.mock.calls[0] as unknown[])[0] as PutItemCommand;
    expect(put.input.ConditionExpression).toBe('attribute_not_exists(#sk)');
    expect(put.input.Item?.pk).toEqual({ S: `OUTBOX#${GROUP}` });
    expect(put.input.Item?.expiresAt).toEqual({
      N: String(Math.floor(Date.parse(SENT_AT) / 1000) + SENT_RECORD_TTL_SECONDS),
    });
  });

  it('never writes "NaN" into that number when the instant is unreadable', async () => {
    const send = vi.fn(async () => ({}));
    const store = dynamoSentStore({ send } as unknown as DynamoDBClient, 'bot');
    await store.put(GROUP, record({ sentAt: 'not a date' }));
    const put = (send.mock.calls[0] as unknown[])[0] as PutItemCommand;
    expect(Number(put.input.Item?.expiresAt?.N)).toBeGreaterThan(SENT_RECORD_TTL_SECONDS);
  });

  it('reads the record CONSISTENTLY — an eventual read sends the message twice', async () => {
    const send = vi.fn(async () => ({}));
    const store = dynamoSentStore({ send } as unknown as DynamoDBClient, 'bot');
    await store.get(GROUP, record().commandId);
    const get = (send.mock.calls[0] as unknown[])[0] as GetItemCommand;
    // A redelivery can follow the send it duplicates by milliseconds; a replica that has
    // not caught up answers "never sent" and the dedup is not a dedup.
    expect(get.input.ConsistentRead).toBe(true);
  });

  it('the memory store keeps the first record of a command', async () => {
    const store = memorySentStore();
    await store.put(GROUP, record());
    await store.put(GROUP, record({ waMessageId: 'WA2' }));
    expect((await store.get(GROUP, record().commandId))?.waMessageId).toBe('WA1');
    expect(await store.get(GROUP, 'podium:other:1')).toBeNull();
  });
});
