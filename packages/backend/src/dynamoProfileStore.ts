import {
  BatchGetItemCommand,
  UpdateItemCommand,
  type AttributeValue,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { ACCOUNT_SORT_KEY, accountKey } from './deviceStore';
import {
  PROFILE_SORT_KEY,
  profileKey,
  type ProfileStore,
  type ProfileUpsert,
} from './profileStore';

// Two keys in one batch, so a single throttled retry round is plenty; more would only turn
// one player's decoration into a long stall.
const PROFILE_BATCH_ATTEMPTS = 3;

// Production profile rows live in the score table (#188): one item per publicId in its
// own `player#<id>` partition. Both create and upsert are one UpdateItem; create adds the
// item-absence condition, while createdAt survives later upserts via if_not_exists and
// updatedAt moves every time.
export function dynamoProfileStore(client: DynamoDBClient, tableName: string): ProfileStore {
  const write = (input: ProfileUpsert, createOnly: boolean) =>
    client.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { pk: { S: profileKey(input.publicId) }, sk: { S: PROFILE_SORT_KEY } },
        UpdateExpression:
          'SET #name = :name, #avatar = :avatar, #updatedAt = :now, ' +
          '#createdAt = if_not_exists(#createdAt, :now)',
        // The background locally-decided identity is allowed to create the row, never
        // replace one the editor or another device won first. Put the test in THIS write:
        // a strongly consistent GET followed by an unconditional update still has a race.
        ...(createOnly ? { ConditionExpression: 'attribute_not_exists(#pk)' } : {}),
        ExpressionAttributeNames: {
          '#name': 'name',
          '#avatar': 'avatar',
          '#updatedAt': 'updatedAt',
          '#createdAt': 'createdAt',
          ...(createOnly ? { '#pk': 'pk' } : {}),
        },
        ExpressionAttributeValues: {
          ':name': { S: input.name },
          ':avatar': { S: input.avatar },
          ':now': { S: input.now },
        },
      }),
    );

  return {
    async get(publicId) {
      // TWO rows, ONE read: the profile the player customized and the ACCOUNT row beside it
      // (#204). They share the `player#<id>` partition, and a `sk IN (…)` Query does not
      // exist, so the two exact keys go out as one BatchGetItem — which reads only what is
      // wanted, unlike a partition Query that would also drag in the solved-day collections.
      //
      // Strongly consistent, for the score store's reason: this is a read-after-write path.
      // The editor re-reads its own profile on the next visit and ADOPTS what comes back as
      // both its contents and its save baseline, so an eventually consistent read could hand
      // a player the profile they just replaced — or, on a first save, a 404 that presents
      // their new profile as never customized. The account row is read the same way for the
      // same reason: a device that just linked must not be told its account is gone.
      const keys = [
        { pk: { S: profileKey(publicId) }, sk: { S: PROFILE_SORT_KEY } },
        { pk: { S: accountKey(publicId) }, sk: { S: ACCOUNT_SORT_KEY } },
      ];
      let pending: Record<string, AttributeValue>[] = keys;
      const found = new Map<string, Record<string, AttributeValue>>();
      for (let attempt = 0; pending.length > 0; attempt += 1) {
        if (attempt >= PROFILE_BATCH_ATTEMPTS) {
          throw new Error('Profile batch read left unprocessed keys.');
        }
        const response = await client.send(
          new BatchGetItemCommand({
            RequestItems: { [tableName]: { Keys: pending, ConsistentRead: true } },
          }),
        );
        for (const item of response.Responses?.[tableName] ?? []) {
          const sk = item.sk?.S;
          if (sk) found.set(sk, item);
        }
        pending = response.UnprocessedKeys?.[tableName]?.Keys ?? [];
      }
      const item = found.get(PROFILE_SORT_KEY);
      return {
        live: found.has(ACCOUNT_SORT_KEY),
        profile: item
          ? { publicId, name: item.name?.S ?? '', avatar: item.avatar?.S ?? '' }
          : null,
      };
    },

    async create(input) {
      try {
        await write(input, true);
        return true;
      } catch (error) {
        if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return false;
        throw error;
      }
    },

    async upsert(input) {
      await write(input, false);
    },
  };
}
