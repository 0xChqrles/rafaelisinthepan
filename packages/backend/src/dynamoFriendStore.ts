import {
  QueryCommand,
  TransactWriteItemsCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { FRIENDS_MAX, friendsKey, type FriendLink, type FriendStore } from './friendStore';

// Four items per kept friendship, so 25 of them exactly fill DynamoDB's 100-item
// transaction limit.
const FRIEND_TRANSFER_BATCH = 25;

// Production edges live in the score table (#189), one item per direction. DynamoDB's
// transaction is what makes the pair indivisible: both rows land, or neither does, so no
// reader can ever see a one-sided friendship.
//
// The CAP is counted off the rows themselves rather than kept in a counter item, for the
// reason the histogram is derived from the score rows: a second store answering the same
// question drifts, and here it would drift into refusing links a player has room for. Two
// concurrent clicks can therefore both pass a check at 199 and land a 201st edge — a cap is
// a BOUND on griefing and on the board read's size, not an invariant, and overshooting it
// by the number of simultaneous clicks costs nothing.
export function dynamoFriendStore(client: DynamoDBClient, tableName: string): FriendStore {
  // Strongly consistent everywhere, for the profile read's reason: the handler answers every
  // call with the caller's list, so a write must be visible to the read that follows it.
  async function edges(publicId: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const response = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: '#pk = :pk',
          ExpressionAttributeNames: { '#pk': 'pk' },
          ExpressionAttributeValues: { ':pk': { S: friendsKey(publicId) } },
          ConsistentRead: true,
          ...(cursor ? { ExclusiveStartKey: cursor as never } : {}),
        }),
      );
      // A row with no sort key is no friend — skipping beats pushing an empty id into a
      // list the board would render a blank row for.
      for (const item of response.Items ?? []) if (item.sk?.S) ids.push(item.sk.S);
      cursor = response.LastEvaluatedKey;
    } while (cursor);
    return ids;
  }

  // The other side's cap needs a number, not a list.
  async function edgeCount(publicId: string): Promise<number> {
    let count = 0;
    let cursor: Record<string, unknown> | undefined;
    do {
      const response = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: '#pk = :pk',
          ExpressionAttributeNames: { '#pk': 'pk' },
          ExpressionAttributeValues: { ':pk': { S: friendsKey(publicId) } },
          Select: 'COUNT',
          ConsistentRead: true,
          ...(cursor ? { ExclusiveStartKey: cursor as never } : {}),
        }),
      );
      count += response.Count ?? 0;
      cursor = response.LastEvaluatedKey;
    } while (cursor);
    return count;
  }

  return {
    list: edges,

    async link({ publicId, friendId, createdAt }) {
      const own = await edges(publicId);
      // The cap gates a pair the CALLER does not already hold. A player at the limit
      // re-opening a link they already accepted must not be refused a friendship they
      // already have — but they are still refused a genuinely new one.
      const held = own.includes(friendId);
      if (!held) {
        if (own.length >= FRIENDS_MAX) return { outcome: 'capped', friends: own };
        if ((await edgeCount(friendId)) >= FRIENDS_MAX) return { outcome: 'capped', friends: own };
      }

      const edge = (from: string, to: string) => ({
        Update: {
          TableName: tableName,
          Key: { pk: { S: friendsKey(from) }, sk: { S: to } },
          UpdateExpression: 'SET #createdAt = if_not_exists(#createdAt, :createdAt)',
          ExpressionAttributeNames: { '#createdAt': 'createdAt' },
          ExpressionAttributeValues: { ':createdAt': { S: createdAt } },
        },
      });
      // ALWAYS both rows, re-link included — the shape `unlink` already has, and what makes
      // the healing claim true in the direction this store cannot see. Reading the caller's
      // partition says nothing about the friend's, so an early return on "I already have this
      // one" would leave the OTHER half missing forever, which is exactly the state a link is
      // supposed to be incapable of. The writes are unconditional and `if_not_exists` keeps
      // the original instant, so re-writing a row that is already there costs two WCUs on a
      // rare path and changes nothing — which is also why this transaction needs no
      // ClientRequestToken: an SDK retry is the same no-op.
      await client.send(
        new TransactWriteItemsCommand({
          TransactItems: [edge(publicId, friendId), edge(friendId, publicId)],
        }),
      );
      // The transaction committed exactly the one edge the read was missing, so the
      // resulting list is the one just read plus it — kept in the Query's sort-key order.
      // Re-reading the partition would spend a second strongly-consistent Query to learn
      // what this call already decided.
      return {
        outcome: held ? 'already_linked' : 'linked',
        friends: held ? own : [...own, friendId].sort(),
      };
    },

    async unlink(publicId, friendId) {
      await client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Delete: {
                TableName: tableName,
                Key: { pk: { S: friendsKey(publicId) }, sk: { S: friendId } },
              },
            },
            {
              Delete: {
                TableName: tableName,
                Key: { pk: { S: friendsKey(friendId) }, sk: { S: publicId } },
              },
            },
          ],
        }),
      );
    },

    // The same partition `list` reads, WITH the instants — #204's merge fills the adopting
    // account's remaining capacity oldest-first, so it needs them and every other caller
    // does not.
    async entries(publicId) {
      const rows: FriendLink[] = [];
      let cursor: Record<string, unknown> | undefined;
      do {
        const response = await client.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: '#pk = :pk',
            ExpressionAttributeNames: { '#pk': 'pk' },
            ExpressionAttributeValues: { ':pk': { S: friendsKey(publicId) } },
            ConsistentRead: true,
            ...(cursor ? { ExclusiveStartKey: cursor as never } : {}),
          }),
        );
        for (const item of response.Items ?? []) {
          const friendId = item.sk?.S;
          if (friendId) rows.push({ publicId, friendId, createdAt: item.createdAt?.S ?? '' });
        }
        cursor = response.LastEvaluatedKey;
      } while (cursor);
      return rows;
    },

    // #204's friend merge, in batches of at most FRIEND_TRANSFER_BATCH friendships — four
    // items each, which is what keeps a full 200-edge merge inside DynamoDB's 100-item
    // transaction limit. Each batch is indivisible, so no reader can ever see one direction
    // of a friendship pointing at the account being deleted while the other points at the
    // one adopting it.
    //
    // IDEMPOTENT throughout, because the job that drives it is resumed after partial
    // batches: the deletes are unconditional (deleting an absent row is a no-op) and the
    // puts keep the OLDER `createdAt` via `if_not_exists`, so replaying a batch changes
    // nothing.
    async transfer(from, to, moves) {
      for (let i = 0; i < moves.length; i += FRIEND_TRANSFER_BATCH) {
        const batch = moves.slice(i, i + FRIEND_TRANSFER_BATCH);
        const items = batch.flatMap((move) => {
          // Both `from`-facing rows go, kept or dropped: no edge may be left pointing at an
          // account that is about to stop existing.
          const removals = [
            {
              Delete: {
                TableName: tableName,
                Key: { pk: { S: friendsKey(from) }, sk: { S: move.friendId } },
              },
            },
            {
              Delete: {
                TableName: tableName,
                Key: { pk: { S: friendsKey(move.friendId) }, sk: { S: from } },
              },
            },
          ];
          if (!move.keep) return removals;
          const link = (owner: string, other: string) => ({
            Update: {
              TableName: tableName,
              Key: { pk: { S: friendsKey(owner) }, sk: { S: other } },
              UpdateExpression: 'SET #createdAt = if_not_exists(#createdAt, :createdAt)',
              ExpressionAttributeNames: { '#createdAt': 'createdAt' },
              ExpressionAttributeValues: { ':createdAt': { S: move.createdAt } },
            },
          });
          return [...removals, link(to, move.friendId), link(move.friendId, to)];
        });
        await client.send(new TransactWriteItemsCommand({ TransactItems: items }));
      }
    },
  };
}
