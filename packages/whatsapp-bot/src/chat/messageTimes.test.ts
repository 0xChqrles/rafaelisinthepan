import type { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { MESSAGE_TIME_TTL_SECONDS, dynamoMessageTimes, memoryMessageTimes } from './messageTimes';

const GROUP = '120363000000000001@g.us';
const AT = Date.parse('2026-10-01T12:00:00Z');

describe('when a quoted message was sent', () => {
  it('stores an id and an instant, never text, expiring after the window', async () => {
    const send = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ Item: { at: { N: String(AT) } } }).mockResolvedValueOnce({});
    const times = dynamoMessageTimes({ send } as unknown as DynamoDBClient, 'bot');
    await times.put(GROUP, 'ABC', AT);
    const put = (send.mock.calls[0] as unknown[])[0] as PutItemCommand;
    expect(put.input.Item).toEqual({
      pk: { S: `MSGAT#${GROUP}` },
      sk: { S: 'ABC' },
      at: { N: String(AT) },
      expiresAt: { N: String(AT / 1000 + MESSAGE_TIME_TTL_SECONDS) },
    });
    expect(await times.get(GROUP, 'ABC')).toBe(AT);
    const get = (send.mock.calls[1] as unknown[])[0] as GetItemCommand;
    expect(get.input.Key).toEqual({ pk: { S: `MSGAT#${GROUP}` }, sk: { S: 'ABC' } });
    expect(await times.get(GROUP, 'NOPE')).toBeNull();
  });

  it('answers null for a message never noted, per group', async () => {
    const times = memoryMessageTimes();
    await times.put(GROUP, 'ABC', AT);
    expect(await times.get(GROUP, 'ABC')).toBe(AT);
    expect(await times.get('120363000000000002@g.us', 'ABC')).toBeNull();
  });
});
