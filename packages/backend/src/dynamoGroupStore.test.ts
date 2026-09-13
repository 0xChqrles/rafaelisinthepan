import { describe, expect, it, vi } from 'vitest';
import {
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { dynamoGroupStore } from './dynamoGroupStore';
import { GROUP_MEMBERS_MAX, GROUPS_MAX } from './groupStore';

const ME = 'lfd5pqz5pa7zjm5u';
const THEM = 'nq2yv6cme4jkbhtx';
const GROUP = 'abcdefghij234567';
const NOW = '2026-09-13T14:00:00.000Z';

// A client that answers a group row, a member list, membership counts, and records what
// it was sent.
function fakeClient(opts: { group?: boolean; held?: boolean; members?: number; mine?: number } = {}) {
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof GetItemCommand) {
      const sk = command.input.Key?.sk?.S ?? '';
      if (sk === 'group') {
        return opts.group === false
          ? {}
          : { Item: { name: { S: 'Les_copains' }, createdBy: { S: ME }, createdAt: { S: NOW } } };
      }
      return opts.held ? { Item: { joinedAt: { S: NOW } } } : {};
    }
    if (command instanceof QueryCommand) {
      const pk = command.input.ExpressionAttributeValues?.[':pk']?.S ?? '';
      const count = pk.startsWith('group#') ? (opts.members ?? 0) : (opts.mine ?? 0);
      if (command.input.Select === 'COUNT') return { Count: count };
      return {
        Items: Array.from({ length: count }, (_, i) => ({
          sk: { S: pk.startsWith('group#') ? `member#m${String(i).padStart(14, '0')}` : `group#g${String(i).padStart(14, '0')}` },
          joinedAt: { S: NOW },
          name: { S: 'G' },
          createdBy: { S: ME },
        })),
      };
    }
    return {};
  });
  return { send, client: { send } as unknown as DynamoDBClient };
}

const transactions = (send: ReturnType<typeof vi.fn>) =>
  send.mock.calls
    .map(([command]) => command)
    .filter((command): command is TransactWriteItemsCommand => command instanceof TransactWriteItemsCommand);

describe('dynamoGroupStore (#271)', () => {
  it('creates the group row AND the creator membership pair in ONE transaction', async () => {
    const { send, client } = fakeClient();
    await expect(
      dynamoGroupStore(client, 'scores').create({ id: GROUP, name: 'Les_copains', createdBy: ME, now: NOW }),
    ).resolves.toBe('created');
    const [tx] = transactions(send);
    const items = tx.input.TransactItems!;
    expect(items).toHaveLength(4);
    expect(items[0].ConditionCheck?.Key).toEqual({ pk: { S: `player#${ME}` }, sk: { S: 'account' } });
    expect(items[1].Put?.Item).toMatchObject({ pk: { S: `group#${GROUP}` }, sk: { S: 'group' }, name: { S: 'Les_copains' } });
    expect(items[1].Put?.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(items[2].Put?.Item).toMatchObject({ pk: { S: `group#${GROUP}` }, sk: { S: `member#${ME}` } });
    // The player-side row DENORMALIZES the immutable name and creator: the list is one Query.
    expect(items[3].Put?.Item).toMatchObject({
      pk: { S: `player#${ME}` },
      sk: { S: `group#${GROUP}` },
      name: { S: 'Les_copains' },
      createdBy: { S: ME },
    });
  });

  it('refuses a create at GROUPS_MAX without writing', async () => {
    const { send, client } = fakeClient({ mine: GROUPS_MAX });
    await expect(
      dynamoGroupStore(client, 'scores').create({ id: GROUP, name: 'X', createdBy: ME, now: NOW }),
    ).resolves.toBe('group_limit');
    expect(transactions(send)).toHaveLength(0);
  });

  it('joins with both rows in one transaction asserting the account and the group', async () => {
    const { send, client } = fakeClient({ members: 3, mine: 1 });
    await expect(dynamoGroupStore(client, 'scores').join({ id: GROUP, publicId: THEM, now: NOW })).resolves.toBe('joined');
    const [tx] = transactions(send);
    const items = tx.input.TransactItems!;
    expect(items.map((item) => item.ConditionCheck?.Key ?? item.Put?.Item?.sk)).toEqual([
      { pk: { S: `player#${THEM}` }, sk: { S: 'account' } },
      { pk: { S: `group#${GROUP}` }, sk: { S: 'group' } },
      { S: `member#${THEM}` },
      { S: `group#${GROUP}` },
    ]);
  });

  it('answers already / unknown_group / group_full / group_limit before writing', async () => {
    const store = (opts: Parameters<typeof fakeClient>[0]) => {
      const { send, client } = fakeClient(opts);
      return { send, store: dynamoGroupStore(client, 'scores') };
    };
    const held = store({ held: true });
    await expect(held.store.join({ id: GROUP, publicId: THEM, now: NOW })).resolves.toBe('already');
    const none = store({ group: false });
    await expect(none.store.join({ id: GROUP, publicId: THEM, now: NOW })).resolves.toBe('unknown_group');
    const full = store({ members: GROUP_MEMBERS_MAX });
    await expect(full.store.join({ id: GROUP, publicId: THEM, now: NOW })).resolves.toBe('group_full');
    const busy = store({ members: 1, mine: GROUPS_MAX });
    await expect(busy.store.join({ id: GROUP, publicId: THEM, now: NOW })).resolves.toBe('group_limit');
    for (const { send } of [held, none, full, busy]) expect(transactions(send)).toHaveLength(0);
  });

  it('reads a refused join off the transaction reasons: account gone, group gone, raced', async () => {
    const refusedAt = (index: number) => {
      const { client } = fakeClient({ members: 1 });
      const base = client.send as unknown as ReturnType<typeof vi.fn>;
      const send = vi.fn(async (command: unknown) => {
        if (command instanceof TransactWriteItemsCommand) {
          throw Object.assign(new Error('refused'), {
            name: 'TransactionCanceledException',
            CancellationReasons: [0, 1, 2, 3].map((i) => ({ Code: i === index ? 'ConditionalCheckFailed' : 'None' })),
          });
        }
        return base(command);
      });
      return dynamoGroupStore({ send } as unknown as DynamoDBClient, 'scores');
    };
    await expect(refusedAt(0).join({ id: GROUP, publicId: THEM, now: NOW })).resolves.toBe('gone');
    await expect(refusedAt(1).join({ id: GROUP, publicId: THEM, now: NOW })).resolves.toBe('unknown_group');
    await expect(refusedAt(2).join({ id: GROUP, publicId: THEM, now: NOW })).resolves.toBe('already');
  });

  it('leaves by deleting both rows together, unconditionally', async () => {
    const { send, client } = fakeClient();
    await dynamoGroupStore(client, 'scores').leave(GROUP, THEM);
    const [tx] = transactions(send);
    expect(tx.input.TransactItems!.map((item) => item.Delete?.Key)).toEqual([
      { pk: { S: `group#${GROUP}` }, sk: { S: `member#${THEM}` } },
      { pk: { S: `player#${THEM}` }, sk: { S: `group#${GROUP}` } },
    ]);
    expect(tx.input.TransactItems!.every((item) => item.Delete?.ConditionExpression === undefined)).toBe(true);
  });

  it('lists members and own groups in joinedAt order off strongly consistent Queries', async () => {
    const { send, client } = fakeClient({ members: 2, mine: 1 });
    const store = dynamoGroupStore(client, 'scores');
    expect((await store.members(GROUP)).map((m) => m.publicId)).toEqual(['m00000000000000', 'm00000000000001']);
    expect(await store.listMine(ME)).toEqual([{ id: 'g00000000000000', name: 'G', createdBy: ME, joinedAt: NOW }]);
    for (const [command] of send.mock.calls) {
      expect((command as QueryCommand).input.ConsistentRead).toBe(true);
    }
  });

  it('leaveAll re-reads until the partition is empty, and gives up loudly otherwise', async () => {
    let passes = 0;
    const { client } = fakeClient({ mine: 2 });
    const base = client.send as unknown as ReturnType<typeof vi.fn>;
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof QueryCommand) {
        passes += 1;
        return passes > 1 ? { Items: [] } : base(command);
      }
      return base(command);
    });
    await dynamoGroupStore({ send } as unknown as DynamoDBClient, 'scores').leaveAll(ME);
    const [tx] = transactions(send);
    expect(tx.input.TransactItems).toHaveLength(4);

    const stuck = fakeClient({ mine: 1 });
    await expect(dynamoGroupStore(stuck.client, 'scores').leaveAll(ME)).rejects.toThrow(/converge/);
  });
});
