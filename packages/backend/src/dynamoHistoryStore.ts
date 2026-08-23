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

      // The collection is FULL and does not hold this day: read it, drop the oldest, write
      // the bounded set back. One extra read and one extra write, on a path a player reaches
      // after MAX_SOLVED_DAYS solved days in one language — where a plain `ADD` would grow
      // the item forever. Unconditional, because the value it writes is derived from a
      // strongly consistent read of a collection that only ever gains a day at a time, and
      // because this is a rebuildable cache: the round rows remain the authority.
      const next = boundSolvedDays([...(await read(publicId, lang)), day]);
      await client.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: itemKey(publicId, lang),
          UpdateExpression: 'SET #days = :days',
          ExpressionAttributeNames: { '#days': 'days' },
          // A number set can never be empty; `next` holds at least the day just added.
          ExpressionAttributeValues: { ':days': { NS: next.map(String) } },
        }),
      );
    },
  };
}
