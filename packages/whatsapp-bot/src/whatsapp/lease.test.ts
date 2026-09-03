import { describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException, PutItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { acquireLease } from './lease';

describe('single-session lease (#236)', () => {
  it('acquires only when free or expired, renews as owner, releases by expiring', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const lease = await acquireLease({ send } as unknown as DynamoDBClient, 'bot', 'test', () => 1_000);
    expect(lease).not.toBeNull();
    const put = (send.mock.calls[0] as unknown[])[0] as PutItemCommand;
    expect(put.input.ConditionExpression).toBe(
      'attribute_not_exists(#sk) OR #exp < :now OR #owner = :owner',
    );
    expect(put.input.Item?.expiresAtMs).toEqual({ N: '91000' });
    expect(await lease!.renew()).toBe(true);
    await lease!.release();
    const release = (send.mock.calls[2] as unknown[])[0] as PutItemCommand;
    expect(release.input.Item?.expiresAtMs).toEqual({ N: '0' });
  });

  it('refuses to start while another holder is alive', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new ConditionalCheckFailedException({ message: 'held', $metadata: {} }));
    expect(await acquireLease({ send } as unknown as DynamoDBClient, 'bot', 'laptop')).toBeNull();
  });
});
