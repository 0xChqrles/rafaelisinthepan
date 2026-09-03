import { describe, expect, it, vi } from 'vitest';
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  PutItemCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  LEASE_GRACE_MS,
  LEASE_RENEW_MS,
  LEASE_TTL_MS,
  acquireLease,
  keepLease,
  type Lease,
  type LeaseLoss,
} from './lease';

// Let an already-resolved renew run its continuations before the next tick reads the state.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('single-session lease (#236)', () => {
  // Every expression attribute a request names must be used by its expression, or DynamoDB
  // refuses the whole request — which a mock never does, so the test checks it by hand.
  function expectExactAttributes(input: {
    ConditionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, unknown>;
  }) {
    const used = new Set(input.ConditionExpression?.match(/[#:][a-zA-Z]+/g) ?? []);
    expect(new Set(Object.keys(input.ExpressionAttributeNames ?? {}))).toEqual(
      new Set([...used].filter((n) => n.startsWith('#'))),
    );
    expect(new Set(Object.keys(input.ExpressionAttributeValues ?? {}))).toEqual(
      new Set([...used].filter((n) => n.startsWith(':'))),
    );
  }

  it('acquires only when free or expired, renews as owner, releases by DELETING', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const lease = await acquireLease({ send } as unknown as DynamoDBClient, 'bot', 'test', () => 1_000);
    expect(lease).not.toBeNull();
    expect(lease!.acquiredAt).toBe(1_000);
    const put = (send.mock.calls[0] as unknown[])[0] as PutItemCommand;
    expect(put.input.ConditionExpression).toBe(
      'attribute_not_exists(#sk) OR #exp < :now OR #owner = :owner',
    );
    expect(put.input.Item?.expiresAtMs).toEqual({ N: '91000' });
    expectExactAttributes(put.input);

    expect(await lease!.renew()).toBe(true);
    const renew = (send.mock.calls[1] as unknown[])[0] as PutItemCommand;
    expect(renew.input.ConditionExpression).toBe('#owner = :owner');
    expectExactAttributes(renew.input);

    // A delete, conditioned on the owner: a renew still in flight when the holder let go
    // carries the same condition, which cannot pass on a row that is gone — so it cannot
    // resurrect the lease the way a late write over an expiry stamp could.
    await lease!.release();
    const release = (send.mock.calls[2] as unknown[])[0] as DeleteItemCommand;
    expect(release).toBeInstanceOf(DeleteItemCommand);
    expect(release.input.ConditionExpression).toBe('#owner = :owner');
    expectExactAttributes(release.input);
  });

  it('refuses to start while another holder is alive', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new ConditionalCheckFailedException({ message: 'held', $metadata: {} }));
    expect(await acquireLease({ send } as unknown as DynamoDBClient, 'bot', 'laptop')).toBeNull();
  });

  it('refuses an acquisition whose answer arrived after the grace window', async () => {
    // The expiry was stamped when the write was BUILT; a slow or retried answer can land
    // after the record has aged into another process's reach. The keeper's rule applies to
    // the acquisition too: past the grace window the answer proves nothing.
    const clock = { ms: 0 };
    const send = vi.fn(async () => {
      clock.ms += LEASE_GRACE_MS;
      return {};
    });
    await expect(
      acquireLease({ send } as unknown as DynamoDBClient, 'bot', 'task', () => clock.ms),
    ).rejects.toThrow(/cannot be trusted/);
    // Handed back rather than left to age out on its own.
    expect((send.mock.calls[1] as unknown[])[0]).toBeInstanceOf(DeleteItemCommand);
  });
});

describe('keeping the lease (#236)', () => {
  function keeperFor(renew: () => Promise<boolean>, clock: { ms: number }) {
    const lost: LeaseLoss[] = [];
    const errors: number[] = [];
    const lease: Lease = { owner: 'test', acquiredAt: clock.ms, renew, release: async () => {} };
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

  it('stops when a renew simply HANGS — the failure that raises no error', async () => {
    const clock = { ms: 0 };
    // Never settles, so the catch block is never reached: only the tick that finds it
    // still outstanding can notice the record ageing out under us.
    const { keeper, lost } = keeperFor(() => new Promise<boolean>(() => {}), clock);

    clock.ms = LEASE_RENEW_MS;
    void keeper.tick(); // issues the renew that will never answer
    expect(lost).toEqual([]);

    // The window still runs from the last renew that LANDED, which here is none of them.
    clock.ms = LEASE_GRACE_MS - 1;
    await keeper.tick();
    expect(lost).toEqual([]);

    clock.ms = LEASE_GRACE_MS;
    await keeper.tick();
    expect(lost).toEqual(['stale']);
  });

  it('measures its window from when a renew was ISSUED, and never runs two at once', async () => {
    const clock = { ms: 0 };
    let started = 0;
    let release: ((held: boolean) => void) | null = null;
    const { keeper, lost } = keeperFor(() => {
      started += 1;
      return new Promise<boolean>((resolve) => {
        release = resolve;
      });
    }, clock);

    void keeper.tick(); // issued at 0 — the record it writes expires at LEASE_TTL_MS
    clock.ms = LEASE_RENEW_MS + 1;
    await keeper.tick();
    // Two overlapping writes can land out of order, and the older carries an EARLIER
    // expiry — so the second tick starts nothing.
    expect(started).toBe(1);

    release!(true);
    await flush();

    // It landed, but late. Measured from the ANSWER the holder would carry on past
    // LEASE_TTL_MS, still believing it held a record that had already expired.
    clock.ms = LEASE_GRACE_MS - 1;
    void keeper.tick(); // a renew that will not answer either
    expect(lost).toEqual([]);
    clock.ms = LEASE_GRACE_MS;
    await keeper.tick();
    expect(lost).toEqual(['stale']);
    expect(LEASE_GRACE_MS).toBeLessThan(LEASE_TTL_MS);
  });

  it('measures the FIRST window from the acquisition stamp, not from its own construction', async () => {
    const clock = { ms: 0 };
    // Acquired at 0; the keeper is built later, once the slow answer came back.
    const lease: Lease = {
      owner: 'test',
      acquiredAt: 0,
      renew: () => new Promise<boolean>(() => {}),
      release: async () => {},
    };
    clock.ms = LEASE_RENEW_MS;
    const lost: LeaseLoss[] = [];
    const keeper = keepLease(lease, { onLost: (reason) => lost.push(reason) }, { now: () => clock.ms, start: false });
    void keeper.tick(); // hangs
    clock.ms = LEASE_GRACE_MS;
    await keeper.tick();
    // Measured from construction it would still have a renew period to spare here.
    expect(lost).toEqual(['stale']);
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
