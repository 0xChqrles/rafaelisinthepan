import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
  type DynamoDBClient,
  type TransactWriteItem,
} from '@aws-sdk/client-dynamodb';
import { DEVICE_INDEX_PARTITION_KEY, LINK_CODE_MAX_ATTEMPTS } from '@whippin/shared';
import {
  ACCOUNT_SORT_KEY,
  DEVICE_SORT_KEY,
  accountKey,
  deviceIndexKey,
  deviceKey,
} from './deviceStore';
import {
  BINDING_SORT_KEY,
  CHALLENGE_SORT_KEY,
  MERGE_SORT_PREFIX,
  SEND_SORT_KEY,
  bindingKey,
  challengeKey,
  mergeKey,
  mergeSortKey,
  sendKey,
  sendWindow,
  type AccountAdoption,
  type EmailBinding,
  type LinkStore,
  type LinkVerifyResult,
} from './linkStore';
import { PROFILE_SORT_KEY, profileKey } from './profileStore';

// Production link rows live in the score table beside everything else (#204).
//
// This is the ONE file that writes items belonging to more than one store's key space, and
// deliberately so: `adopt` has to be a single transaction, and the half-states are not
// equally harmless — a device left on a DELETED account is a player signed out mid-link
// with everything gone. Every key it writes comes from the OWNING module's own formatter
// (`deviceKey`, `accountKey`, `profileKey`), never a literal, so the two files cannot drift
// onto two spellings of one item.

function isConditionFailure(error: unknown): boolean {
  return (
    error instanceof ConditionalCheckFailedException ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'ConditionalCheckFailedException')
  );
}

export function dynamoLinkStore(client: DynamoDBClient, tableName: string): LinkStore {
  const challengeItem = async (hash: string): Promise<Record<string, AttributeValue> | undefined> => {
    const response = await client.send(
      new GetItemCommand({
        TableName: tableName,
        Key: { pk: { S: challengeKey(hash) }, sk: { S: CHALLENGE_SORT_KEY } },
        // Strongly consistent for the profile read's reason: this classifies a refusal that
        // has just been written by this very request.
        ConsistentRead: true,
      }),
    );
    return response.Item;
  };

  return {
    async spendSend(scope, hash, limit, windowSeconds, now) {
      try {
        await client.send(
          new UpdateItemCommand({
            TableName: tableName,
            Key: {
              pk: { S: sendKey(scope, hash, sendWindow(now, windowSeconds)) },
              sk: { S: SEND_SORT_KEY },
            },
            // ONE conditional increment. The window is in the KEY, so the counter never has
            // to be reset and the condition is path-only — DynamoDB's condition grammar has
            // no arithmetic (the round store's rule).
            UpdateExpression: 'ADD #count :one SET #expiresAt = :expiresAt',
            ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
            ExpressionAttributeNames: { '#count': 'count', '#expiresAt': 'expiresAt' },
            ExpressionAttributeValues: {
              ':one': { N: '1' },
              ':limit': { N: String(limit) },
              // The item's own TTL: two windows of slack, because DynamoDB's TTL deletion is
              // best-effort and lags — an allowance item that outlives its window costs
              // nothing, since the NEXT window is a different key.
              ':expiresAt': {
                N: String(Math.floor(now.getTime() / 1000) + windowSeconds * 2),
              },
            },
          }),
        );
        return true;
      } catch (error) {
        if (isConditionFailure(error)) return false;
        throw error;
      }
    },

    async putChallenge(hash, challenge) {
      // A re-send REPLACES: the player is holding the newest mail, and leaving the previous
      // code alive would only widen the guessing surface.
      await client.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: { pk: { S: challengeKey(hash) }, sk: { S: CHALLENGE_SORT_KEY } },
          UpdateExpression:
            'SET #codeHash = :codeHash, #attempts = :attempts, #createdAt = :createdAt, #expiresAt = :expiresAt',
          ExpressionAttributeNames: {
            '#codeHash': 'codeHash',
            '#attempts': 'attempts',
            '#createdAt': 'createdAt',
            '#expiresAt': 'expiresAt',
          },
          ExpressionAttributeValues: {
            ':codeHash': { S: challenge.codeHash },
            ':attempts': { N: String(challenge.attempts) },
            ':createdAt': { S: challenge.createdAt },
            ':expiresAt': { N: String(challenge.expiresAt) },
          },
        }),
      );
    },

    async verify(hash, codeHash, now): Promise<LinkVerifyResult> {
      const seconds = Math.floor(now.getTime() / 1000);
      try {
        // The attempt is counted by a write whose CONDITION is "the code is wrong", so a
        // correct code never spends one — which matters, because one successful link can
        // legitimately verify twice (the erase confirmation asks, the player confirms, the
        // second call carries the parameter). The count is the only thing between a
        // six-digit code and a guessing loop, so it may not be a read-then-write.
        const response = await client.send(
          new UpdateItemCommand({
            TableName: tableName,
            Key: { pk: { S: challengeKey(hash) }, sk: { S: CHALLENGE_SORT_KEY } },
            UpdateExpression: 'SET #attempts = if_not_exists(#attempts, :zero) + :one',
            ConditionExpression:
              'attribute_exists(pk) AND #attempts < :max AND #expiresAt > :now AND #codeHash <> :codeHash',
            ExpressionAttributeNames: {
              '#attempts': 'attempts',
              '#expiresAt': 'expiresAt',
              '#codeHash': 'codeHash',
            },
            ExpressionAttributeValues: {
              ':zero': { N: '0' },
              ':one': { N: '1' },
              ':max': { N: String(LINK_CODE_MAX_ATTEMPTS) },
              ':now': { N: String(seconds) },
              ':codeHash': { S: codeHash },
            },
            ReturnValues: 'ALL_NEW',
          }),
        );
        const attempts = Number(response.Attributes?.attempts?.N ?? LINK_CODE_MAX_ATTEMPTS);
        return {
          outcome: attempts >= LINK_CODE_MAX_ATTEMPTS ? 'spent' : 'wrong',
          attemptsLeft: Math.max(0, LINK_CODE_MAX_ATTEMPTS - attempts),
        };
      } catch (error) {
        if (!isConditionFailure(error)) throw error;
      }
      // The condition refused, which means one of FOUR things — the code was right, the
      // attempts are gone, the challenge expired, or there is none. Only the exceptional
      // path pays for this read (the happy path pays it too, which is the deliberate trade:
      // a correct code costs two round trips, a wrong one costs one and can never be free).
      const item = await challengeItem(hash);
      if (!item) return { outcome: 'none', attemptsLeft: 0 };
      const attempts = Number(item.attempts?.N ?? '0');
      if (Number(item.expiresAt?.N ?? '0') <= seconds) return { outcome: 'expired', attemptsLeft: 0 };
      if (attempts >= LINK_CODE_MAX_ATTEMPTS) return { outcome: 'spent', attemptsLeft: 0 };
      return { outcome: 'ok', attemptsLeft: LINK_CODE_MAX_ATTEMPTS - attempts };
    },

    async binding(hash): Promise<EmailBinding | null> {
      const response = await client.send(
        new GetItemCommand({
          TableName: tableName,
          Key: { pk: { S: bindingKey(hash) }, sk: { S: BINDING_SORT_KEY } },
          ConsistentRead: true,
        }),
      );
      const accountId = response.Item?.accountId?.S;
      if (!accountId) return null;
      return { accountId, createdAt: response.Item?.createdAt?.S ?? '' };
    },

    async bind(input) {
      try {
        await client.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Put: {
                  TableName: tableName,
                  Item: {
                    pk: { S: bindingKey(input.emailHash) },
                    sk: { S: BINDING_SORT_KEY },
                    accountId: { S: input.accountId },
                    createdAt: { S: input.now },
                  },
                  // CREATE-ONLY: a device that lost the race to this address must not
                  // overwrite the binding that won it.
                  ConditionExpression: 'attribute_not_exists(pk)',
                },
              },
              {
                Update: {
                  TableName: tableName,
                  Key: { pk: { S: accountKey(input.accountId) }, sk: { S: ACCOUNT_SORT_KEY } },
                  UpdateExpression: 'SET #email = :email, #emailAt = :now',
                  // The account must still exist: binding an address to a deleted account
                  // would make the address reach nobody, permanently.
                  ConditionExpression: 'attribute_exists(pk)',
                  ExpressionAttributeNames: { '#email': 'email', '#emailAt': 'emailAt' },
                  ExpressionAttributeValues: {
                    ':email': { S: input.email },
                    ':now': { S: input.now },
                  },
                },
              },
              {
                Delete: {
                  TableName: tableName,
                  Key: { pk: { S: challengeKey(input.emailHash) }, sk: { S: CHALLENGE_SORT_KEY } },
                },
              },
            ],
          }),
        );
        return 'bound';
      } catch (error) {
        if (isConditionFailure(error)) return 'taken';
        throw error;
      }
    },

    async adopt(input: AccountAdoption) {
      const items: TransactWriteItem[] = [
        {
          // The ONE device item MOVES. Its base key is the token's hash and does not change;
          // only the account it names and the index key the sign-out screen reads it by.
          Update: {
            TableName: tableName,
            Key: { pk: { S: deviceKey(input.tokenHash) }, sk: { S: DEVICE_SORT_KEY } },
            UpdateExpression: 'SET #accountId = :to, #gsi1pk = :index, #lastSeenAt = :now',
            ConditionExpression: '#accountId = :from AND #deviceId = :deviceId',
            ExpressionAttributeNames: {
              '#accountId': 'accountId',
              '#deviceId': 'deviceId',
              '#gsi1pk': DEVICE_INDEX_PARTITION_KEY,
              '#lastSeenAt': 'lastSeenAt',
            },
            ExpressionAttributeValues: {
              ':to': { S: input.to },
              ':from': { S: input.from },
              ':deviceId': { S: input.deviceId },
              ':index': { S: deviceIndexKey(input.to) },
              ':now': { S: input.now },
            },
          },
        },
        {
          // Consuming the challenge inside this transaction is what makes the whole
          // verification one-shot.
          Delete: {
            TableName: tableName,
            Key: { pk: { S: challengeKey(input.emailHash) }, sk: { S: CHALLENGE_SORT_KEY } },
          },
        },
      ];
      if (input.mergeFrom !== undefined) {
        items.push({
          Put: {
            TableName: tableName,
            Item: {
              pk: { S: mergeKey(input.to) },
              sk: { S: mergeSortKey(input.mergeFrom) },
              createdAt: { S: input.now },
            },
          },
        });
      }
      if (input.erase) {
        // The account row AND the profile row. Identity-bearing reads resolve a face through
        // the profile row and check the account row beside it, so leaving either behind
        // would keep exposing an account the player has left for good.
        items.push(
          {
            Delete: {
              TableName: tableName,
              Key: { pk: { S: accountKey(input.from) }, sk: { S: ACCOUNT_SORT_KEY } },
            },
          },
          {
            Delete: {
              TableName: tableName,
              Key: { pk: { S: profileKey(input.from) }, sk: { S: PROFILE_SORT_KEY } },
            },
          },
        );
      }
      await client.send(new TransactWriteItemsCommand({ TransactItems: items }));
    },

    async pendingMerges(accountId) {
      const from: string[] = [];
      let cursor: Record<string, AttributeValue> | undefined;
      do {
        const response = await client.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
            ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
            ExpressionAttributeValues: {
              ':pk': { S: mergeKey(accountId) },
              ':prefix': { S: MERGE_SORT_PREFIX },
            },
            ConsistentRead: true,
            ...(cursor ? { ExclusiveStartKey: cursor } : {}),
          }),
        );
        for (const item of response.Items ?? []) {
          const sk = item.sk?.S;
          if (sk?.startsWith(MERGE_SORT_PREFIX)) from.push(sk.slice(MERGE_SORT_PREFIX.length));
        }
        cursor = response.LastEvaluatedKey;
      } while (cursor);
      return from.sort();
    },

    async clearMerge(accountId, from) {
      // Unconditional and therefore idempotent: deleting an absent item is a no-op, which is
      // what a job finishing twice has to be.
      await client.send(
        new DeleteItemCommand({
          TableName: tableName,
          Key: { pk: { S: mergeKey(accountId) }, sk: { S: mergeSortKey(from) } },
        }),
      );
    },
  };
}
