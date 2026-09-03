import { describe, expect, it, vi } from 'vitest';
import {
  ConditionalCheckFailedException,
  UpdateItemCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { dynamoLimitStore, limitKeys, memoryLimitStore } from './limits';

describe('conversational ceilings (#236)', () => {
  it('counts per UTC day, per sender / group / everyone', () => {
    const now = new Date('2026-09-03T23:30:00Z');
    expect(limitKeys.user('g@g.us', 'u@lid', now)).toEqual({
      scope: 'LIMIT#g@g.us',
      key: 'DAY#2026-09-03#USER#u@lid',
    });
    expect(limitKeys.group('g@g.us', now).key).toBe('DAY#2026-09-03#GROUP');
    expect(limitKeys.calls(now)).toEqual({ scope: 'LIMIT#ALL', key: 'DAY#2026-09-03#CALLS' });
  });

  it('the memory store reaches the ceiling and never passes it', async () => {
    const store = memoryLimitStore();
    expect(await store.take('s', 'k', 2, 0)).toBe(true);
    expect(await store.take('s', 'k', 2, 0)).toBe(true);
    expect(await store.take('s', 'k', 2, 0)).toBe(false);
  });

  it('the DynamoDB store spells the ceiling as the update\'s own condition', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }));
    const store = dynamoLimitStore({ send } as unknown as DynamoDBClient, 'bot');
    expect(await store.take('LIMIT#g', 'k', 5, 123)).toBe(true);
    expect(await store.take('LIMIT#g', 'k', 5, 123)).toBe(false);
    expect(await store.take('LIMIT#g', 'k', 0, 123)).toBe(false);
    const update = (send.mock.calls[0] as unknown[])[0] as UpdateItemCommand;
    expect(update.input.ConditionExpression).toBe('attribute_not_exists(#n) OR #n < :max');
    expect(update.input.ExpressionAttributeValues?.[':max']).toEqual({ N: '5' });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
