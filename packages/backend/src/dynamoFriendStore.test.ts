import { describe, expect, it, vi } from 'vitest';
import {
  QueryCommand,
  TransactWriteItemsCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { dynamoFriendStore } from './dynamoFriendStore';
import { FRIENDS_MAX } from './friendStore';

const ME = 'lfd5pqz5pa7zjm5u';
const THEM = 'nq2yv6cme4jkbhtx';
const NOW = '2026-08-19T14:00:00.000Z';

// A client that answers every Query with `edges` and records what it was sent.
function fakeClient(edges: string[] = [], count = edges.length) {
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof QueryCommand) {
      return command.input.Select === 'COUNT'
        ? { Count: count }
        : { Items: edges.map((id) => ({ sk: { S: id } })) };
    }
    return {};
  });
  return { send, client: { send } as unknown as DynamoDBClient };
}

describe('dynamoFriendStore (#189)', () => {
  it('writes BOTH directions in ONE transaction — a half-edge is unrepresentable', async () => {
    const { send, client } = fakeClient();
    await expect(
      dynamoFriendStore(client, 'scores').link({ publicId: ME, friendId: THEM, createdAt: NOW }),
    ).resolves.toEqual({ outcome: 'linked', friends: [THEM] });

    const transactions = send.mock.calls
      .map(([command]) => command)
      .filter((command): command is TransactWriteItemsCommand =>
        command instanceof TransactWriteItemsCommand,
      );
    expect(transactions).toHaveLength(1);
    const items = transactions[0].input.TransactItems!;
    expect(items).toHaveLength(4);
    expect(items.slice(0, 2).map((item) => item.ConditionCheck?.Key)).toEqual([
      { pk: { S: `player#${ME}` }, sk: { S: 'account' } },
      { pk: { S: `player#${THEM}` }, sk: { S: 'account' } },
    ]);
    const updates = items.flatMap((item) => (item.Update ? [item.Update] : []));
    expect(updates.map((update) => update.Key)).toEqual([
      { pk: { S: `friends#${ME}` }, sk: { S: THEM } },
      { pk: { S: `friends#${THEM}` }, sk: { S: ME } },
    ]);
    // "Friends since" belongs to the FIRST link, so a retry (or a re-click that raced the
    // membership read) rewrites the same rows without restating when it happened.
    for (const update of updates) {
      expect(update.UpdateExpression).toContain('if_not_exists(#createdAt, :createdAt)');
      expect(update.ExpressionAttributeValues).toEqual({ ':createdAt': { S: NOW } });
    }
  });

  it('refuses without edges when either live-account condition loses its race', async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof QueryCommand) {
        return command.input.Select === 'COUNT' ? { Count: 0 } : { Items: [] };
      }
      throw Object.assign(new Error('account disappeared'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [
          { Code: 'None' },
          { Code: 'ConditionalCheckFailed' },
          { Code: 'None' },
          { Code: 'None' },
        ],
      });
    });
    const store = dynamoFriendStore({ send } as unknown as DynamoDBClient, 'scores');

    await expect(
      store.link({ publicId: ME, friendId: THEM, createdAt: NOW }),
    ).resolves.toEqual({ outcome: 'gone', friends: [] });
  });

  it('deletes BOTH directions in ONE transaction', async () => {
    const { send, client } = fakeClient();
    await dynamoFriendStore(client, 'scores').unlink(ME, THEM);

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as TransactWriteItemsCommand;
    expect(command).toBeInstanceOf(TransactWriteItemsCommand);
    expect(command.input.TransactItems!.map((item) => item.Delete?.Key)).toEqual([
      { pk: { S: `friends#${ME}` }, sk: { S: THEM } },
      { pk: { S: `friends#${THEM}` }, sk: { S: ME } },
    ]);
  });

  it('reads a player partition CONSISTENTLY — every call answers with the list it just wrote', async () => {
    const { send, client } = fakeClient([THEM]);
    await expect(dynamoFriendStore(client, 'scores').list(ME)).resolves.toEqual([THEM]);

    const command = send.mock.calls[0][0] as QueryCommand;
    expect(command.input).toMatchObject({
      TableName: 'scores',
      ExpressionAttributeValues: { ':pk': { S: `friends#${ME}` } },
      ConsistentRead: true,
    });
  });

  it('re-links BOTH rows when the caller already holds theirs, so the pair repairs', async () => {
    // The store can see the CALLER's partition and not the friend's, so "I already have
    // this edge" is no evidence the other half exists. Returning early on it would leave a
    // half-edge unrepairable from this side forever — the one state a link may not produce.
    const { send, client } = fakeClient([THEM]);
    await expect(
      dynamoFriendStore(client, 'scores').link({ publicId: ME, friendId: THEM, createdAt: NOW }),
    ).resolves.toEqual({ outcome: 'already_linked', friends: [THEM] });

    const transactions = send.mock.calls
      .map(([command]) => command)
      .filter((command): command is TransactWriteItemsCommand =>
        command instanceof TransactWriteItemsCommand,
      );
    expect(transactions).toHaveLength(1);
    const updates = transactions[0].input.TransactItems!.flatMap((item) =>
      item.Update ? [item.Update] : [],
    );
    expect(updates.map((update) => update.Key)).toEqual([
      { pk: { S: `friends#${ME}` }, sk: { S: THEM } },
      { pk: { S: `friends#${THEM}` }, sk: { S: ME } },
    ]);
    // The row that WAS there keeps its own instant: the repair does not restate when two
    // players became friends.
    for (const update of updates) {
      expect(update.UpdateExpression).toContain('if_not_exists(#createdAt, :createdAt)');
    }
  });

  it('does not spend the cap on an edge the caller already holds', async () => {
    // At the limit, a re-click is still the friendship they already have — and it still
    // writes, so a missing other half is repaired even for a full player.
    const full = Array.from({ length: FRIENDS_MAX - 1 }, (_, i) => `x${String(i).padStart(15, '0')}`);
    const { send, client } = fakeClient([...full, THEM]);
    await expect(
      dynamoFriendStore(client, 'scores').link({ publicId: ME, friendId: THEM, createdAt: NOW }),
    ).resolves.toMatchObject({ outcome: 'already_linked' });
    expect(send.mock.calls.some(([c]) => c instanceof TransactWriteItemsCommand)).toBe(true);
    // The other side's count was never asked for: the pair is not new.
    expect(send.mock.calls.every(([c]) => !(c instanceof QueryCommand) || c.input.Select !== 'COUNT')).toBe(
      true,
    );
  });

  it('writes nothing at the cap', async () => {
    const full = Array.from({ length: FRIENDS_MAX }, (_, i) => `x${String(i).padStart(15, '0')}`);
    const { send, client } = fakeClient(full);
    await expect(
      dynamoFriendStore(client, 'scores').link({ publicId: ME, friendId: THEM, createdAt: NOW }),
    ).resolves.toEqual({ outcome: 'capped', friends: full });
    expect(send.mock.calls.every(([c]) => !(c instanceof TransactWriteItemsCommand))).toBe(true);
  });
});

// CONTRACT (#204): the merge rewrites BOTH directions of every kept friendship onto the
// adopting account, and removes both facing rows of every friendship it keeps OR drops —
// **no link may be left pointing at an account that is about to stop existing.** Four items
// per kept friendship is what bounds the batch at 25: DynamoDB refuses a 101-item
// transaction, and a full 200-edge merge has to fit inside repeated ones.
describe('dynamoFriendStore.transfer (#204)', () => {
  const TO = 'zzzzzzzzzzzzzzzz';

  it('removes both facing rows and writes both new ones, keeping the OLDER instant', async () => {
    const { send, client } = fakeClient();
    await dynamoFriendStore(client, 'scores').transfer(ME, TO, [
      { friendId: THEM, keep: true, createdAt: NOW },
    ]);

    const items = (send.mock.calls[0][0] as TransactWriteItemsCommand).input.TransactItems!;
    expect(items).toHaveLength(4);
    expect(items.flatMap((i) => (i.Delete ? [[i.Delete.Key!.pk.S, i.Delete.Key!.sk.S]] : []))).toEqual([
      [`friends#${ME}`, THEM],
      [`friends#${THEM}`, ME],
    ]);
    const links = items.flatMap((i) => (i.Update ? [i.Update] : []));
    expect(links.map((u) => [u.Key!.pk.S, u.Key!.sk.S])).toEqual([
      [`friends#${TO}`, THEM],
      [`friends#${THEM}`, TO],
    ]);
    // `if_not_exists` keeps the ORIGINAL instant, which is also what makes replaying a
    // partial batch a no-op — the job that drives this is resumed.
    for (const update of links) {
      expect(update.UpdateExpression).toBe('SET #createdAt = if_not_exists(#createdAt, :createdAt)');
    }
  });

  it('conditions a KEPT move on the planned edge still standing, and re-plans without one that is gone', async () => {
    const OTHER = 'pq7dm2vh3xk9wbrt';
    let writes = 0;
    const send = vi.fn(async (command: unknown) => {
      writes += 1;
      const items = (command as TransactWriteItemsCommand).input.TransactItems!;
      if (writes === 1) {
        // THEM unlinked `from` between the plan and the write: their `from`-facing row is
        // gone, so its conditional delete refuses the whole batch.
        throw Object.assign(new Error('cancelled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: items.map((_, index) => ({
            Code: index === 0 ? 'ConditionalCheckFailed' : 'None',
          })),
        });
      }
      return {};
    });
    const client = { send } as unknown as DynamoDBClient;
    await dynamoFriendStore(client, 'scores').transfer(ME, TO, [
      { friendId: THEM, keep: true, createdAt: NOW },
      { friendId: OTHER, keep: false, createdAt: NOW },
    ]);

    const first = (send.mock.calls[0][0] as TransactWriteItemsCommand).input.TransactItems!;
    // A kept move's `from`-side delete names its condition; a drop's deletes name none.
    expect(first[0].Delete!.ConditionExpression).toBe('attribute_exists(pk)');
    expect(first[1].Delete!.ConditionExpression).toBeUndefined();
    expect(first[4].Delete!.ConditionExpression).toBeUndefined();
    // The retry writes the batch WITHOUT the friendship somebody ended — no `to`↔THEM rows,
    // which would have resurrected it — and still drops OTHER.
    expect(send).toHaveBeenCalledTimes(2);
    const second = (send.mock.calls[1][0] as TransactWriteItemsCommand).input.TransactItems!;
    expect(second).toHaveLength(2);
    expect(second.map((item) => [item.Delete!.Key!.pk.S, item.Delete!.Key!.sk.S])).toEqual([
      [`friends#${ME}`, OTHER],
      [`friends#${OTHER}`, ME],
    ]);
  });

  it('propagates a transaction cancelled for any reason but a condition', async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error('throttled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ThrottlingError' }, { Code: 'None' }],
      });
    });
    await expect(
      dynamoFriendStore({ send } as unknown as DynamoDBClient, 'scores').transfer(ME, TO, [
        { friendId: THEM, keep: false, createdAt: NOW },
      ]),
    ).rejects.toThrow(/throttled/);
  });

  it('DROPS a friendship by removing its two facing rows and writing nothing else', async () => {
    const { send, client } = fakeClient();
    await dynamoFriendStore(client, 'scores').transfer(ME, TO, [
      { friendId: THEM, keep: false, createdAt: NOW },
    ]);
    const items = (send.mock.calls[0][0] as TransactWriteItemsCommand).input.TransactItems!;
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.Delete !== undefined)).toBe(true);
  });

  it('batches so no transaction can exceed DynamoDB\'s 100-item limit', async () => {
    const { send, client } = fakeClient();
    const moves = Array.from({ length: FRIENDS_MAX }, (_, i) => ({
      friendId: `y${String(i).padStart(15, '0')}`,
      keep: true,
      createdAt: NOW,
    }));
    await dynamoFriendStore(client, 'scores').transfer(ME, TO, moves);

    const transactions = send.mock.calls
      .map(([command]) => command)
      .filter((command): command is TransactWriteItemsCommand =>
        command instanceof TransactWriteItemsCommand,
      );
    expect(transactions).toHaveLength(FRIENDS_MAX / 25);
    for (const transaction of transactions) {
      expect(transaction.input.TransactItems!.length).toBeLessThanOrEqual(100);
    }
  });
});
