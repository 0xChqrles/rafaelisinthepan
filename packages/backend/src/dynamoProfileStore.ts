import {
  BatchGetItemCommand,
  UpdateItemCommand,
  type AttributeValue,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { ACCOUNT_SORT_KEY, accountKey } from './deviceStore';
import { isConditionFailure } from './dynamoErrors';
import { batchRetryDelayMs, sleep, type Wait } from './dynamoRetry';
import {
  PROFILE_SORT_KEY,
  profileKey,
  type ProfileStore,
  type ProfileUpsert,
} from './profileStore';

// THREE ATTEMPTS: the first read plus TWO retries. Only two keys go out, so a partition
// under enough pressure to leave one unprocessed three times running is not going to clear
// inside this request — and this read decorates a board row or answers one profile, where
// a long stall costs more than a loud failure. (The comment here used to say "a single
// retry round", which the count never was.)
const PROFILE_BATCH_ATTEMPTS = 3;

export interface DynamoProfileStoreOptions {
  // Injected by tests, so asserting the retry SCHEDULE costs no real time.
  wait?: Wait;
}

// Production profile rows live in the score table (#188): one item per publicId in its
// own `player#<id>` partition. Both create and upsert are one UpdateItem; create adds the
// item-absence condition, while createdAt survives later upserts via if_not_exists and
// updatedAt moves every time.
export function dynamoProfileStore(
  client: DynamoDBClient,
  tableName: string,
  options: DynamoProfileStoreOptions = {},
): ProfileStore {
  const wait = options.wait ?? sleep;
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
      //
      // UnprocessedKeys are RETRIED, and the retry WAITS — the score/round batch reads'
      // shared full-jitter schedule (`dynamoRetry.ts`). Coming straight back spends the
      // whole budget inside a few milliseconds, before any capacity can return, which is
      // the throttle turning itself into a failure. Only the keys DynamoDB handed back are
      // asked for again, and exhausting the budget THROWS: answering with what arrived
      // would present a missing profile row as "never customized" (404) or a missing
      // account row as "gone" (410) — a throttle rendered as a verdict about an identity.
      let pending: Record<string, AttributeValue>[] = keys;
      const found = new Map<string, Record<string, AttributeValue>>();
      for (let attempt = 0; pending.length > 0; attempt += 1) {
        if (attempt >= PROFILE_BATCH_ATTEMPTS) {
          throw new Error('Profile batch read left unprocessed keys.');
        }
        // Only BETWEEN attempts: the first read of a batch is never delayed.
        if (attempt > 0) await wait(batchRetryDelayMs(attempt - 1));
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
        if (isConditionFailure(error)) return false;
        throw error;
      }
    },

    async upsert(input) {
      await write(input, false);
    },
  };
}
