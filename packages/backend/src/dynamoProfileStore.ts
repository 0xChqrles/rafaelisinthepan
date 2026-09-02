import {
  TransactGetItemsCommand,
  UpdateItemCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { ACCOUNT_SORT_KEY, accountKey } from './deviceStore';
import { classifyTransaction, isConditionFailure } from './dynamoErrors';
import { CONFLICT_RETRY_ATTEMPTS, conflictDelayMs, sleep, type Wait } from './dynamoRetry';
import {
  PROFILE_SORT_KEY,
  profileKey,
  type ProfileStore,
  type ProfileUpsert,
} from './profileStore';

export interface DynamoProfileStoreOptions {
  // Injected by tests, so asserting the conflict SCHEDULE costs no real time.
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
      // TWO rows, ONE OBSERVATION: the profile the player customized and the ACCOUNT row
      // beside it (#204), read as a TRANSACTION.
      //
      // **It was a strongly consistent BatchGetItem, and that is not the same thing**
      // (corrected 2026-09-02, PR-227 follow-up review). Strong consistency is per ITEM: a
      // batch read is serializable with respect to each item SEPARATELY and not across the
      // batch, so it can observe one side of a transactional write and not the other — and
      // the deletion this lookup exists to detect removes BOTH rows in one transaction
      // (#204's adoption). The harmful skew is exact: the ACCOUNT row observed before the
      // delete and the PROFILE row after it answers `{live: true, profile: null}`, which
      // every identity-bearing surface dresses with the assigned pseudonym and mark — a
      // deleted player drawn as a person, which is the one thing `live` exists to prevent.
      // Accumulating across `UnprocessedKeys` retries widens that window; nothing about the
      // two rows sharing a partition closes it.
      //
      // A transactional read is ONE serializable snapshot, so `live` and `profile` always
      // describe the same instant. Three things follow. It needs NO new IAM: a `Get`
      // element is authorized by `dynamodb:GetItem`, which the table grant already carries
      // (`ConditionCheckItem` belongs to the WRITE transaction). It needs no
      // `ConsistentRead`, because a transactional read is serializable by definition —
      // which is exactly what the editor's read-after-write needs (it ADOPTS what comes
      // back as both its contents and its save baseline, so a stale answer hands a player
      // the profile they just replaced, or a first save a 404 saying they never customized
      // one). And there are no UnprocessedKeys to retry: a transactional read either
      // answers in full or is CANCELLED, and the one cancellation worth retrying is
      // `TransactionConflict` — a concurrent write on one of these two rows — which waits
      // on the shared jittered schedule and asks again from a FRESH snapshot.
      //
      // It costs twice the read units of the batch it replaces. The alternative that keeps
      // them — reading the profile, then the account row LAST, so a live answer is never
      // staler than an absent profile — buys that back with a second round trip on a read
      // the board already fans out per row. One observation is the simpler thing to reason
      // about, and the fan-out is bounded by the board's own row count.
      let conflict: unknown;
      for (let attempt = 0; attempt <= CONFLICT_RETRY_ATTEMPTS; attempt += 1) {
        // Only BETWEEN attempts: the first read is never delayed.
        if (attempt > 0) await wait(conflictDelayMs(attempt - 1));
        try {
          const response = await client.send(
            new TransactGetItemsCommand({
              TransactItems: [
                {
                  Get: {
                    TableName: tableName,
                    Key: { pk: { S: profileKey(publicId) }, sk: { S: PROFILE_SORT_KEY } },
                  },
                },
                {
                  Get: {
                    TableName: tableName,
                    Key: { pk: { S: accountKey(publicId) }, sk: { S: ACCOUNT_SORT_KEY } },
                  },
                },
              ],
            }),
          );
          // Positional, and that is the contract: the responses come back in the order the
          // items were sent, with no `Item` where the row is absent. NOTHING is carried
          // over from an earlier attempt — a snapshot is only a snapshot whole.
          const rows = response.Responses ?? [];
          const item = rows[0]?.Item;
          return {
            live: rows[1]?.Item !== undefined,
            profile: item
              ? { publicId, name: item.name?.S ?? '', avatar: item.avatar?.S ?? '' }
              : null,
          };
        } catch (error) {
          // A cancellation that is NOT a conflict is operational and surfaces: answering
          // with half a read would present a throttle as a verdict about an identity —
          // "never customized" (404) or "gone" (410).
          if (classifyTransaction(error).kind !== 'conflict') throw error;
          conflict = error;
        }
      }
      throw conflict;
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
