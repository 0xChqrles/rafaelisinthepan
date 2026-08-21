import {
  GetItemCommand,
  UpdateItemCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { ROUND_GUESS_CAP, ROUND_WRITE_MIN_MS } from '@whippin/shared';
import { roundPartition, type RoundAppendInput, type RoundState, type RoundStore } from './roundStore';

// Production round records live in the score table (#201): one item per
// (date, lang, mode, publicId) in its own `round#<date>#<lang>#<mode>` partition.
//
// The append is ONE conditional UpdateItem — the cap and the per-player write interval
// are two clauses of the same ConditionExpression as the `list_append` itself, so a
// refused append cannot be raced past either bound. Success returns the updated item
// (ReturnValues) so the happy path is one call; a failed condition reads the item once,
// consistently, to classify the refusal — the condition cannot say which clause rejected
// it, and the caller owes the client the distinction (a cap stops the round; a rate
// refusal only delays it).
export function dynamoRoundStore(client: DynamoDBClient, tableName: string): RoundStore {
  const read = async (input: RoundAppendInput): Promise<RoundState | null> => {
    const response = await client.send(
      new GetItemCommand({
        TableName: tableName,
        Key: { pk: { S: roundPartition(input) }, sk: { S: input.publicId } },
        // Strong consistency, for the score store's reason: this classifies the refusal
        // of the write that just failed, right after it.
        ConsistentRead: true,
      }),
    );
    return itemToState(response.Item);
  };

  return {
    async get(key, publicId) {
      const response = await client.send(
        new GetItemCommand({
          TableName: tableName,
          Key: { pk: { S: roundPartition(key) }, sk: { S: publicId } },
          // Strong consistency: the read lands right after this player's own appends
          // (the sync's catch-up on load), which must not be invisible to it.
          ConsistentRead: true,
        }),
      );
      return itemToState(response.Item);
    },

    async append(input) {
      const nowMs = input.now.getTime();
      try {
        const response = await client.send(
          new UpdateItemCommand({
            TableName: tableName,
            Key: { pk: { S: roundPartition(input) }, sk: { S: input.publicId } },
            UpdateExpression:
              'SET #g = list_append(if_not_exists(#g, :empty), :batch), ' +
              '#last = :now, #created = if_not_exists(#created, :now)',
            // Both bounds in the write itself (#201's sketch, made exact): the RESULTING
            // log may never exceed the cap (`size + batch <= cap` — the pre-append size
            // alone would let one oversized batch overshoot), and writes from one player
            // sit at least ROUND_WRITE_MIN_MS apart.
            ConditionExpression:
              '(attribute_not_exists(#last) OR #last < :cutoff) ' +
              'AND size(if_not_exists(#g, :empty)) + :n <= :cap',
            ExpressionAttributeNames: {
              '#g': 'guesses',
              '#last': 'lastWriteAt',
              '#created': 'createdAt',
            },
            ExpressionAttributeValues: {
              ':empty': { L: [] },
              ':batch': { L: input.guesses.map((guess) => ({ S: guess })) },
              ':n': { N: String(input.guesses.length) },
              ':cap': { N: String(ROUND_GUESS_CAP) },
              ':now': { N: String(nowMs) },
              ':cutoff': { N: String(nowMs - ROUND_WRITE_MIN_MS) },
            },
            ReturnValues: 'ALL_NEW',
          }),
        );
        return { outcome: 'appended', state: itemToState(response.Attributes)! };
      } catch (error) {
        if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
      }
      // The condition named both bounds; classify against the stored item. A log already
      // at (or within one batch of) the cap is the cap refusal — the truer answer, since
      // retrying can never succeed — and anything else is the interval.
      const current = await read(input);
      const state = current ?? { guesses: [], createdAt: '' };
      const outcome =
        state.guesses.length + input.guesses.length > ROUND_GUESS_CAP ? 'round_full' : 'too_fast';
      return { outcome, state };
    },
  };
}

function itemToState(item: Record<string, unknown> | undefined): RoundState | null {
  if (!item) return null;
  return {
    guesses: (item.guesses as { L?: { S?: string }[] } | undefined)?.L?.map((v) => v.S ?? '') ?? [],
    createdAt: (item.createdAt as { S?: string } | undefined)?.S ?? '',
  };
}
