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
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.Update?.Key)).toEqual([
      { pk: { S: `friends#${ME}` }, sk: { S: THEM } },
      { pk: { S: `friends#${THEM}` }, sk: { S: ME } },
    ]);
    // "Friends since" belongs to the FIRST link, so a retry (or a re-click that raced the
    // membership read) rewrites the same rows without restating when it happened.
    for (const item of items) {
      expect(item.Update?.UpdateExpression).toContain('if_not_exists(#createdAt, :createdAt)');
      expect(item.Update?.ExpressionAttributeValues).toEqual({ ':createdAt': { S: NOW } });
    }
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
    expect(transactions[0].input.TransactItems!.map((item) => item.Update?.Key)).toEqual([
      { pk: { S: `friends#${ME}` }, sk: { S: THEM } },
      { pk: { S: `friends#${THEM}` }, sk: { S: ME } },
    ]);
    // The row that WAS there keeps its own instant: the repair does not restate when two
    // players became friends.
    for (const item of transactions[0].input.TransactItems!) {
      expect(item.Update?.UpdateExpression).toContain('if_not_exists(#createdAt, :createdAt)');
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
