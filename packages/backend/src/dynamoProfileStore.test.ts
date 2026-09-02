import { describe, expect, it, vi } from 'vitest';
import {
  TransactGetItemsCommand,
  UpdateItemCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { dynamoProfileStore } from './dynamoProfileStore';

const PUBLIC_ID = 'lfd5pqz5pa7zjm5u';

describe('dynamoProfileStore (#188)', () => {
  // CONTRACT (#204): the profile row and the ACCOUNT row are ONE OBSERVATION. A missing
  // profile means "never customized" and every board dresses it with the assigned pseudonym
  // and mark — which is still this player's face — so a DELETED account has to be a
  // different answer, and it is the account row's absence that says so. The two therefore
  // have to describe the SAME INSTANT: a batch read is serializable per item and not across
  // the batch, so it could observe the account before #204's deletion and the profile after
  // it, and answer `live: true` for a player who no longer exists.
  const PROFILE_ROW = { name: { S: 'Chqrles' }, avatar: { S: 'AAAAAAAAAAAAAAAAAAA' } };
  const ACCOUNT_ROW = { createdAt: { S: '2026-08-19T14:00:00.000Z' } };
  const snapshot = (profile?: object, account?: object) => ({
    Responses: [profile ? { Item: profile } : {}, account ? { Item: account } : {}],
  });

  it('reads the profile row and the account row as ONE serializable snapshot', async () => {
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(TransactGetItemsCommand);
      return snapshot(PROFILE_ROW, ACCOUNT_ROW);
    });
    const store = dynamoProfileStore({ send } as unknown as DynamoDBClient, 'scores');

    await expect(store.get(PUBLIC_ID)).resolves.toEqual({
      live: true,
      profile: { publicId: PUBLIC_ID, name: 'Chqrles', avatar: 'AAAAAAAAAAAAAAAAAAA' },
    });
    // ONE command, both keys, in the order the answer is read back positionally. A
    // transactional read carries no ConsistentRead: it is serializable by definition,
    // which is what the editor's read-after-write baseline needs.
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0][0] as TransactGetItemsCommand).input).toEqual({
      TransactItems: [
        {
          Get: {
            TableName: 'scores',
            Key: { pk: { S: `player#${PUBLIC_ID}` }, sk: { S: 'profile' } },
          },
        },
        {
          Get: {
            TableName: 'scores',
            Key: { pk: { S: `player#${PUBLIC_ID}` }, sk: { S: 'account' } },
          },
        },
      ],
    });
  });

  it('reports a never-customized identity as a LIVE account with no profile', async () => {
    const send = vi.fn(async (_command: unknown) => snapshot(undefined, ACCOUNT_ROW));
    const store = dynamoProfileStore({ send } as unknown as DynamoDBClient, 'scores');
    await expect(store.get(PUBLIC_ID)).resolves.toEqual({ live: true, profile: null });
  });

  it('reports a DELETED account as not live, whatever the profile row says (#204)', async () => {
    const send = vi.fn(async (_command: unknown) => snapshot(PROFILE_ROW));
    const store = dynamoProfileStore({ send } as unknown as DynamoDBClient, 'scores');
    await expect(store.get(PUBLIC_ID)).resolves.toEqual({
      live: false,
      profile: { publicId: PUBLIC_ID, name: 'Chqrles', avatar: 'AAAAAAAAAAAAAAAAAAA' },
    });
  });

  // CONTRACT (PR-227 follow-up review): a transactional read has no UnprocessedKeys — it
  // answers in full or is CANCELLED — so what this store retries is a `TransactionConflict`,
  // on the shared full-jitter schedule (`dynamoRetry.ts`) and never immediately. Every
  // attempt is a FRESH snapshot: nothing is carried over, which is the property the batch
  // read could not have.
  describe('a concurrent write on one of the two rows', () => {
    const conflict = () =>
      Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'TransactionConflict' }, { Code: 'None' }],
      });

    it('never blends two attempts: the interleaving that made a DELETED account read LIVE', async () => {
      // The reviewer's scenario, in the primitive that replaced the batch. Attempt 1 races
      // #204's adoption — which deletes the account row AND the profile row in one
      // transaction — and is cancelled. By attempt 2 the deletion has landed and BOTH rows
      // are gone. Under the old batch read the account row from the first response was
      // retained across the retry and answered `live: true` for a player who no longer
      // existed; a snapshot cannot do that, because there is nothing to retain.
      let reads = 0;
      const send = vi.fn(async (_command: unknown) => {
        reads += 1;
        if (reads === 1) throw conflict();
        return snapshot();
      });
      const waits: number[] = [];
      const store = dynamoProfileStore({ send } as unknown as DynamoDBClient, 'scores', {
        wait: async (ms) => {
          waits.push(ms);
        },
      });

      await expect(store.get(PUBLIC_ID)).resolves.toEqual({ live: false, profile: null });
      expect(reads).toBe(2);
      // BACKED OFF, and only BETWEEN attempts: the first read is never delayed.
      expect(waits).toHaveLength(1);
      expect(waits[0]).toBeLessThanOrEqual(20);
    });

    it('is BOUNDED, and a conflict it cannot win surfaces rather than answering half a read', async () => {
      const send = vi.fn(async (_command: unknown) => {
        throw conflict();
      });
      const waits: number[] = [];
      const store = dynamoProfileStore({ send } as unknown as DynamoDBClient, 'scores', {
        wait: async (ms) => {
          waits.push(ms);
        },
      });

      // LOUD: contention must never be answered as "never customized" or as "gone".
      await expect(store.get(PUBLIC_ID)).rejects.toThrow(/cancelled/);
      expect(send).toHaveBeenCalledTimes(5);
      expect(waits).toHaveLength(4);
    });

    it('surfaces an OPERATIONAL cancellation at once — a throttle is not a verdict', async () => {
      const throttled = Object.assign(new Error('throttled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ThrottlingError' }, { Code: 'None' }],
      });
      const send = vi.fn(async (_command: unknown) => {
        throw throttled;
      });
      const waits: number[] = [];
      const store = dynamoProfileStore({ send } as unknown as DynamoDBClient, 'scores', {
        wait: async (ms) => {
          waits.push(ms);
        },
      });

      await expect(store.get(PUBLIC_ID)).rejects.toBe(throttled);
      expect(send).toHaveBeenCalledTimes(1);
      expect(waits).toEqual([]);
    });
  });

  it('upserts in one write, keeping createdAt from the FIRST save', async () => {
    const send = vi.fn(async (_command: unknown) => ({}));
    const store = dynamoProfileStore({ send } as unknown as DynamoDBClient, 'scores');
    await store.upsert({
      publicId: PUBLIC_ID,
      name: 'Chqrles',
      avatar: 'AAAAAAAAAAAAAAAAAAA',
      now: '2026-08-19T14:00:00.000Z',
    });

    const command = send.mock.calls[0][0] as UpdateItemCommand;
    expect(command).toBeInstanceOf(UpdateItemCommand);
    expect(command.input).toMatchObject({
      TableName: 'scores',
      Key: { pk: { S: `player#${PUBLIC_ID}` }, sk: { S: 'profile' } },
      ExpressionAttributeValues: {
        ':name': { S: 'Chqrles' },
        ':avatar': { S: 'AAAAAAAAAAAAAAAAAAA' },
        ':now': { S: '2026-08-19T14:00:00.000Z' },
      },
    });
    // The profile row is its own partition: a write here can never touch a score row.
    expect(command.input.UpdateExpression).toContain('if_not_exists(#createdAt, :now)');
  });

  it('creates the first profile with an atomic item-absence condition', async () => {
    const send = vi.fn(async (_command: unknown) => ({}));
    const store = dynamoProfileStore({ send } as unknown as DynamoDBClient, 'scores');
    await expect(
      store.create({
        publicId: PUBLIC_ID,
        name: 'LocalFace',
        avatar: 'AAAAAAAAAAAAAAAAAAA',
        now: '2026-08-26T09:00:00.000Z',
      }),
    ).resolves.toBe(true);

    const command = send.mock.calls[0][0] as UpdateItemCommand;
    expect(command.input.ConditionExpression).toBe('attribute_not_exists(#pk)');
    expect(command.input.ExpressionAttributeNames?.['#pk']).toBe('pk');
  });

  it('reports a lost create race without replacing the existing profile', async () => {
    const conflict = Object.assign(new Error('exists'), {
      name: 'ConditionalCheckFailedException',
    });
    const send = vi.fn(async (_command: unknown) => Promise.reject(conflict));
    const store = dynamoProfileStore({ send } as unknown as DynamoDBClient, 'scores');

    await expect(
      store.create({
        publicId: PUBLIC_ID,
        name: 'Background',
        avatar: 'AAAAAAAAAAAAAAAAAAA',
        now: '2026-08-26T09:00:00.000Z',
      }),
    ).resolves.toBe(false);
  });
});
