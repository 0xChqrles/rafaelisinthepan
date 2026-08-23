import {
  GetItemCommand,
  UpdateItemCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { boundSolvedDays, MAX_SOLVED_DAYS } from '@whippin/shared';
import { historyPartition, historySortKey, type PlayerHistoryStore } from './historyStore';

// The solved-day collection is a DynamoDB NUMBER SET, and that type is the whole design:
// `ADD` is an idempotent set insert, so crediting a day needs no read, no condition on the
// value, and no way for two confirmations of one solve to record it twice.
//
// The item shares the score table like every other row here: `player#<publicId>` partition
// (the private player row), `history#<lang>` sort key.
export function dynamoHistoryStore(
  client: DynamoDBClient,
  tableName: string,
): PlayerHistoryStore {
  const itemKey = (publicId: string, lang: string) => ({
    pk: { S: historyPartition(publicId) },
    sk: { S: historySortKey(lang) },
  });

  const read = async (publicId: string, lang: string): Promise<number[]> => {
    const response = await client.send(
      new GetItemCommand({
        TableName: tableName,
        Key: itemKey(publicId, lang),
        // Strongly consistent, the profile read's rule: the solve that credits a day is
        // recorded by the append that finishes the round, and the streak is read moments
        // later on the same device. An eventually consistent read would show the player a
        // streak that has not yet counted the day they just finished.
        ConsistentRead: true,
      }),
    );
    const stored = response.Item?.days?.NS ?? [];
    return boundSolvedDays(stored.map(Number).filter((day) => Number.isFinite(day)));
  };

  return {
    solvedDays: read,

    async recordSolvedDay({ publicId, lang, day }) {
      try {
        await client.send(
          new UpdateItemCommand({
            TableName: tableName,
            Key: itemKey(publicId, lang),
            UpdateExpression: 'ADD #days :day',
            // Path-only CONDITION syntax, the round store's rule: `size(<path>)` and
            // `contains` are both in DynamoDB's condition grammar, arithmetic is not. The
            // three clauses are the three ways this write is legitimate — no collection
            // yet, room left in it, or a day it ALREADY holds (which must stay a silent
            // no-op rather than falling into the overflow rewrite below).
            ConditionExpression:
              'attribute_not_exists(#days) OR size(#days) < :max OR contains(#days, :one)',
            ExpressionAttributeNames: { '#days': 'days' },
            ExpressionAttributeValues: {
              ':day': { NS: [String(day)] },
              ':max': { N: String(MAX_SOLVED_DAYS) },
              ':one': { N: String(day) },
            },
          }),
        );
        return;
      } catch (error) {
        if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
      }

      // The condition named three ways this write is legitimate, so its refusal says all
      // three failed: the collection EXISTS, is at the cap, and does not hold this day.
      //
      // **Both remaining writes stay SET OPERATIONS, and that is the whole point** (corrected
      // on review). A read-then-`SET #days = :whole` is a lost update: two credits for
      // different eligible days read the same 800 and write back two sets that each omit the
      // other's day, so one solve disappears — on the one path that is a player's streak.
      // `ADD` and `DELETE` name ELEMENTS, so they commute with a concurrent credit of a
      // different day, and no read the caller took can go stale between them.
      //
      // The ADD is unconditional (the fast path above already established there is room for
      // nothing) and returns the MERGED set, which is what the trim is computed from — the
      // true post-write membership, including whatever landed concurrently, rather than a
      // snapshot taken before it.
      const merged = await client.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: itemKey(publicId, lang),
          UpdateExpression: 'ADD #days :day',
          ExpressionAttributeNames: { '#days': 'days' },
          ExpressionAttributeValues: { ':day': { NS: [String(day)] } },
          ReturnValues: 'ALL_NEW',
        }),
      );

      // Whatever now sits BEYOND the cap, oldest first. Concurrent credits may each drop the
      // same element — a DELETE of an absent one is a no-op — so the collection can sit a
      // day or two over the cap until the next credit trims again. That is a BOUND overshot
      // by simultaneous writes, the shape `FRIENDS_MAX` already has, and it converges; a
      // lost solved day would not.
      // Sorted but deliberately NOT bounded — `boundSolvedDays` is what DROPS the overflow,
      // and this is the one place that needs to see it in order to delete it.
      const all = (merged.Attributes?.days?.NS ?? [])
        .map(Number)
        .filter((value) => Number.isFinite(value))
        .sort((a, b) => a - b);
      const drop = all.slice(0, Math.max(0, all.length - MAX_SOLVED_DAYS));
      if (drop.length === 0) return;
      await client.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: itemKey(publicId, lang),
          UpdateExpression: 'DELETE #days :drop',
          ExpressionAttributeNames: { '#days': 'days' },
          ExpressionAttributeValues: { ':drop': { NS: drop.map(String) } },
        }),
      );
    },
  };
}
