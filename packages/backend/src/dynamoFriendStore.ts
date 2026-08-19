import {
  QueryCommand,
  TransactWriteItemsCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { FRIENDS_MAX, friendsKey, type FriendStore } from './friendStore';

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
  };
}
