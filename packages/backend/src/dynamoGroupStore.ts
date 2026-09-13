import {
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type DynamoDBClient,
  type TransactWriteItem,
} from '@aws-sdk/client-dynamodb';
import { ACCOUNT_SORT_KEY, accountKey } from './deviceStore';
import { classifyTransaction, refusedAt } from './dynamoErrors';
import {
  GROUP_MEMBERS_MAX,
  GROUP_SORT_KEY,
  GROUPS_MAX,
  MEMBER_SORT_PREFIX,
  PLAYER_GROUP_SORT_PREFIX,
  byJoinedAt,
  groupKey,
  memberSortKey,
  playerGroupSortKey,
  playerGroupsKey,
  type GroupMember,
  type GroupMembership,
  type GroupRecord,
  type GroupStore,
} from './groupStore';

// Two delete items per membership, so 50 of them exactly fill DynamoDB's 100-item
// transaction limit — and GROUPS_MAX is far under it, so a departure is one transaction.
const LEAVE_ALL_BATCH = 50;
// A pass that finds nothing ends the loop; this bound only catches a store that is not
// shrinking the partition it was told to, which is a bug rather than a retry.
const LEAVE_ALL_MAX_PASSES = 4;

// Production groups live in the score table (#271), three item shapes (groupStore.ts).
// DynamoDB's transaction is what makes a membership indivisible: both rows land, or
// neither does, so no reader can ever see a one-sided membership.
export function dynamoGroupStore(client: DynamoDBClient, tableName: string): GroupStore {
  // Strongly consistent everywhere, for the profile read's reason: the route answers every
  // call with the caller's list, so a write must be visible to the read that follows it.
  async function query(
    pk: string,
    prefix: string,
    select?: 'COUNT',
  ): Promise<{ items: Record<string, AttributeValue>[]; count: number }> {
    const items: Record<string, AttributeValue>[] = [];
    let count = 0;
    let cursor: Record<string, AttributeValue> | undefined;
    do {
      const response = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
          ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
          ExpressionAttributeValues: { ':pk': { S: pk }, ':prefix': { S: prefix } },
          ConsistentRead: true,
          ...(select ? { Select: select } : {}),
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      );
      items.push(...(response.Items ?? []));
      count += response.Count ?? 0;
      cursor = response.LastEvaluatedKey;
    } while (cursor);
    return { items, count };
  }

  const countMine = async (publicId: string) =>
    (await query(playerGroupsKey(publicId), PLAYER_GROUP_SORT_PREFIX, 'COUNT')).count;
  const countMembers = async (id: string) =>
    (await query(groupKey(id), MEMBER_SORT_PREFIX, 'COUNT')).count;

  // The membership pair, as the items ONE transaction writes: the group-side row and the
  // player-side row, the latter carrying the group's immutable name and creator so the
  // caller's list is one Query.
  const membershipItems = (
    group: GroupRecord,
    publicId: string,
    joinedAt: string,
  ): TransactWriteItem[] => [
    {
      Put: {
        TableName: tableName,
        Item: {
          pk: { S: groupKey(group.id) },
          sk: { S: memberSortKey(publicId) },
          joinedAt: { S: joinedAt },
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
    {
      Put: {
        TableName: tableName,
        Item: {
          pk: { S: playerGroupsKey(publicId) },
          sk: { S: playerGroupSortKey(group.id) },
          joinedAt: { S: joinedAt },
          name: { S: group.name },
          createdBy: { S: group.createdBy },
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
  ];

  const accountStands = (publicId: string): TransactWriteItem => ({
    ConditionCheck: {
      TableName: tableName,
      Key: { pk: { S: accountKey(publicId) }, sk: { S: ACCOUNT_SORT_KEY } },
      ConditionExpression: 'attribute_exists(pk)',
    },
  });

  const recordOf = (item: Record<string, AttributeValue> | undefined, id: string): GroupRecord | null =>
    item
      ? {
          id,
          name: item.name?.S ?? '',
          createdBy: item.createdBy?.S ?? '',
          createdAt: item.createdAt?.S ?? '',
        }
      : null;

  return {
    async get(id) {
      const response = await client.send(
        new GetItemCommand({
          TableName: tableName,
          Key: { pk: { S: groupKey(id) }, sk: { S: GROUP_SORT_KEY } },
          ConsistentRead: true,
        }),
      );
      return recordOf(response.Item, id);
    },

    async members(id) {
      const { items } = await query(groupKey(id), MEMBER_SORT_PREFIX);
      const rows: GroupMember[] = [];
      for (const item of items) {
        const sk = item.sk?.S;
        // A row with no member id is no member — skipping beats pushing an empty id into
        // a list the board would render a blank row for.
        if (!sk?.startsWith(MEMBER_SORT_PREFIX)) continue;
        rows.push({ publicId: sk.slice(MEMBER_SORT_PREFIX.length), joinedAt: item.joinedAt?.S ?? '' });
      }
      return byJoinedAt(rows, (row) => row.publicId);
    },

    async listMine(publicId) {
      const { items } = await query(playerGroupsKey(publicId), PLAYER_GROUP_SORT_PREFIX);
      const rows: GroupMembership[] = [];
      for (const item of items) {
        const sk = item.sk?.S;
        if (!sk?.startsWith(PLAYER_GROUP_SORT_PREFIX)) continue;
        rows.push({
          id: sk.slice(PLAYER_GROUP_SORT_PREFIX.length),
          name: item.name?.S ?? '',
          createdBy: item.createdBy?.S ?? '',
          joinedAt: item.joinedAt?.S ?? '',
        });
      }
      return byJoinedAt(rows, (row) => row.id);
    },

    async create({ id, name, createdBy, now }) {
      if ((await countMine(createdBy)) >= GROUPS_MAX) return 'group_limit';
      const group: GroupRecord = { id, name, createdBy, createdAt: now };
      try {
        await client.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              accountStands(createdBy),
              {
                // Create-only: a minted id never collides in practice, and one that did
                // must not overwrite somebody else's group.
                Put: {
                  TableName: tableName,
                  Item: {
                    pk: { S: groupKey(id) },
                    sk: { S: GROUP_SORT_KEY },
                    name: { S: name },
                    createdBy: { S: createdBy },
                    createdAt: { S: now },
                  },
                  ConditionExpression: 'attribute_not_exists(pk)',
                },
              },
              ...membershipItems(group, createdBy, now),
            ],
          }),
        );
      } catch (error) {
        // Exactly one reason is a business answer: [0], the creator's account. Anything
        // else — a `TransactionConflict`, a throttle, an id collision, a reason with no
        // code — is OPERATIONAL and surfaces (`dynamoErrors.ts`).
        const verdict = classifyTransaction(error);
        if (verdict.kind === 'refused' && refusedAt(verdict.reasons, 0)) return 'gone';
        throw error;
      }
      return 'created';
    },

    async join({ id, publicId, now }) {
      const group = await this.get(id);
      if (!group) return 'unknown_group';
      // Already a member? The player-side row says so, and an early return here writes
      // nothing — the pair is one transaction, so there is no missing half to repair.
      const held = await client.send(
        new GetItemCommand({
          TableName: tableName,
          Key: { pk: { S: playerGroupsKey(publicId) }, sk: { S: playerGroupSortKey(id) } },
          ConsistentRead: true,
        }),
      );
      if (held.Item) return 'already';
      if ((await countMembers(id)) >= GROUP_MEMBERS_MAX) return 'group_full';
      if ((await countMine(publicId)) >= GROUPS_MAX) return 'group_limit';
      try {
        await client.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              accountStands(publicId),
              {
                // The group must still exist at the write: a group row is never deleted
                // today, but the condition is what keeps that a fact rather than a hope.
                ConditionCheck: {
                  TableName: tableName,
                  Key: { pk: { S: groupKey(id) }, sk: { S: GROUP_SORT_KEY } },
                  ConditionExpression: 'attribute_exists(pk)',
                },
              },
              ...membershipItems(group, publicId, now),
            ],
          }),
        );
      } catch (error) {
        // [0] the caller's account, [1] the group, [2]/[3] the pair — a pair refused is a
        // membership that landed between the read above and this write, which is `already`.
        const verdict = classifyTransaction(error);
        if (verdict.kind === 'refused') {
          if (refusedAt(verdict.reasons, 0)) return 'gone';
          if (refusedAt(verdict.reasons, 1)) return 'unknown_group';
          if (refusedAt(verdict.reasons, 2) || refusedAt(verdict.reasons, 3)) return 'already';
        }
        throw error;
      }
      return 'joined';
    },

    async leave(id, publicId) {
      await client.send(
        new TransactWriteItemsCommand({ TransactItems: leaveItems(tableName, id, publicId) }),
      );
    },

    // #204's departure: a deleted account leaves every group. Read the partition, delete
    // every pair in batches of LEAVE_ALL_BATCH memberships (one transaction each), and
    // read again until nothing is left — a join landing between two passes is simply seen
    // by the next one. The deletes are unconditional, so replaying a batch changes nothing.
    async leaveAll(publicId) {
      for (let pass = 0; pass < LEAVE_ALL_MAX_PASSES; pass += 1) {
        const mine = await this.listMine(publicId);
        if (mine.length === 0) return;
        for (let i = 0; i < mine.length; i += LEAVE_ALL_BATCH) {
          const items = mine
            .slice(i, i + LEAVE_ALL_BATCH)
            .flatMap((group) => leaveItems(tableName, group.id, publicId));
          await client.send(new TransactWriteItemsCommand({ TransactItems: items }));
        }
      }
      throw new Error(`Group departure of ${publicId} did not converge.`);
    },
  };
}

// The two rows one membership is, both deleted: no membership may be left pointing at an
// account that is about to stop existing, and no group may keep listing a member who left.
function leaveItems(tableName: string, id: string, publicId: string): TransactWriteItem[] {
  return [
    {
      Delete: {
        TableName: tableName,
        Key: { pk: { S: groupKey(id) }, sk: { S: memberSortKey(publicId) } },
      },
    },
    {
      Delete: {
        TableName: tableName,
        Key: { pk: { S: playerGroupsKey(publicId) }, sk: { S: playerGroupSortKey(id) } },
      },
    },
  ];
}
