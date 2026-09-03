import { describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException, PutItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  LEASE_GRACE_MS,
  LEASE_RENEW_MS,
  acquireLease,
  keepLease,
  type Lease,
  type LeaseLoss,
} from './lease';

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

describe('keeping the lease (#236)', () => {
  function keeperFor(renew: () => Promise<boolean>, clock: { ms: number }) {
    const lost: LeaseLoss[] = [];
    const errors: number[] = [];
    const lease: Lease = { owner: 'test', renew, release: async () => {} };
    const keeper = keepLease(
      lease,
      { onLost: (reason) => lost.push(reason), onError: (_, staleMs) => errors.push(staleMs) },
      { now: () => clock.ms, start: false },
    );
    return { keeper, lost, errors };
  }

  it('stops the holder the moment a renew is REFUSED', async () => {
    const clock = { ms: 0 };
    const { keeper, lost } = keeperFor(async () => false, clock);
    await keeper.tick();
    expect(lost).toEqual(['refused']);
    // Settled: a later tick does not report it twice.
    await keeper.tick();
    expect(lost).toEqual(['refused']);
  });

  it('rides out a failing renew, then stops BEFORE the record can expire', async () => {
    const clock = { ms: 0 };
    const { keeper, lost, errors } = keeperFor(async () => {
      throw new Error('throttled');
    }, clock);

    clock.ms = LEASE_RENEW_MS;
    await keeper.tick();
    expect(lost).toEqual([]); // a blip is not a lost lease

    clock.ms = LEASE_GRACE_MS - 1;
    await keeper.tick();
    expect(lost).toEqual([]);

    clock.ms = LEASE_GRACE_MS;
    await keeper.tick();
    expect(lost).toEqual(['stale']);
    expect(errors).toEqual([LEASE_RENEW_MS, LEASE_GRACE_MS - 1, LEASE_GRACE_MS]);
    // It gives up with a renew period to spare, so nobody else can be holding it yet.
    expect(LEASE_GRACE_MS).toBeLessThan(90_000);
  });

  it('a renew that LANDS restarts the window', async () => {
    const clock = { ms: 0 };
    let failing = true;
    const { keeper, lost } = keeperFor(async () => {
      if (failing) throw new Error('blip');
      return true;
    }, clock);

    clock.ms = LEASE_GRACE_MS - 1;
    await keeper.tick(); // throws, but inside the window
    failing = false;
    clock.ms = LEASE_GRACE_MS;
    await keeper.tick(); // lands: the window starts again HERE
    failing = true;
    clock.ms = LEASE_GRACE_MS * 2 - 1;
    await keeper.tick();
    expect(lost).toEqual([]);
    clock.ms = LEASE_GRACE_MS * 2;
    await keeper.tick();
    expect(lost).toEqual(['stale']);
  });
});
