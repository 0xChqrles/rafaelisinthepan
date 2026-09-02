import { createHash } from 'node:crypto';
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
import {
  DEVICE_INDEX_PARTITION_KEY,
  LINK_CODE_MAX_ATTEMPTS,
  LINK_SENDS_PER_ADDRESS,
  LINK_SENDS_PER_IP,
} from '@whippin/shared';
import {
  ACCOUNT_SORT_KEY,
  DEVICE_SORT_KEY,
  accountKey,
  deviceIndexKey,
  deviceKey,
} from './deviceStore';
import { planRoundMove } from './dynamoRoundStore';
import { planScoreMove } from './dynamoScoreStore';
import {
  BINDING_SORT_KEY,
  CHALLENGE_SORT_KEY,
  MERGE_SORT_PREFIX,
  SEND_SORT_KEY,
  bindingKey,
  challengeKey,
  mergeKey,
  mergeSortKey,
  recentSends,
  sendKey,
  sameDigest,
  type AccountAdoption,
  type EmailBinding,
  type LinkAdoptResult,
  type LinkMovedRound,
  type LinkStore,
  type LinkVerifyResult,
} from './linkStore';
import { PROFILE_SORT_KEY, profileKey } from './profileStore';

// Production link rows live in the score table beside everything else (#204).
//
// This is the ONE file that writes items belonging to more than one store's key space, and
// deliberately so: `adopt` has to be a single transaction, and the half-states are not
// equally harmless — a device left on a DELETED account is a player signed out mid-link
// with everything gone, and a round moved by an adoption that never commits is play under
// an account nobody holds. Every key it writes comes from the OWNING module's own formatter
// (`deviceKey`, `accountKey`, `profileKey`), never a literal, and the round and score
// halves of the active-day transfer are PLANNED by their own stores (`planRoundMove`,
// `planScoreMove`) — this file only commits the items they hand it.

function isConditionFailure(error: unknown): boolean {
  return (
    error instanceof ConditionalCheckFailedException ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'ConditionalCheckFailedException')
  );
}

interface CancellationReason {
  Code?: string;
}

function cancellationReasons(error: unknown): CancellationReason[] | null {
  if (typeof error !== 'object' || error === null) return null;
  const named = error as { name?: unknown; CancellationReasons?: CancellationReason[] };
  if (named.name !== 'TransactionCanceledException' || !named.CancellationReasons) return null;
  return named.CancellationReasons;
}

function conditionalCancellation(reasons: readonly CancellationReason[]): boolean {
  return (
    reasons.some(({ Code }) => Code === 'ConditionalCheckFailed') &&
    reasons.every(({ Code }) => Code === 'None' || Code === 'ConditionalCheckFailed')
  );
}

function requestToken(kind: string, ...parts: string[]): string {
  return createHash('sha256').update([kind, ...parts].join('\0')).digest('hex').slice(0, 36);
}

// How many times an optimistic send write is retried against a list that keeps changing
// under it. The allowances are small (the largest is LINK_SENDS_PER_IP), so a list that
// changes more often than this inside one request is churn, not contention.
const SEND_WRITE_ATTEMPTS = Math.max(LINK_SENDS_PER_ADDRESS, LINK_SENDS_PER_IP);

// How many times an adoption re-plans the active day's moves when only THEY refused the
// transaction — a guess landed on the source, or the destination gained play, between the
// plan and the commit. A player appends about once a second at most; play that changes
// more often than this inside one request is not a player typing.
const MOVE_PLAN_ATTEMPTS = 4;

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
    async spendSends(allowances, windowSeconds, now) {
      if (allowances.length === 0) return true;
      if (allowances.some(({ limit }) => limit < 1)) return false;
      const keys = allowances.map(({ scope, hash }) => ({
        pk: { S: sendKey(scope, hash) },
        sk: { S: SEND_SORT_KEY },
      }));
      const expiresAt = { N: String(Math.floor(now.getTime() / 1000) + windowSeconds) };
      // A ROLLING window cannot be one conditional increment: what counts is how many sends
      // fall inside the last `windowSeconds`, which no condition can compute. So each scope
      // is read, pruned and written back as ONE optimistic transaction — every Put is
      // conditioned on the exact list its read observed, so a concurrent send on either
      // scope refuses the whole set and it is decided again from what now stands.
      for (let attempt = 0; attempt < SEND_WRITE_ATTEMPTS; attempt += 1) {
        const items = await Promise.all(
          keys.map(async (key) => {
            const response = await client.send(
              new GetItemCommand({ TableName: tableName, Key: key, ConsistentRead: true }),
            );
            return response.Item;
          }),
        );
        const observed = items.map((item) => item?.sends?.L);
        const recent = observed.map((sends) =>
          recentSends(
            (sends ?? []).map((at) => Number(at.N ?? '0')),
            windowSeconds,
            now,
          ),
        );
        if (recent.some((sends, index) => sends.length >= allowances[index].limit)) return false;
        try {
          await client.send(
            new TransactWriteItemsCommand({
              TransactItems: keys.map((key, index) => ({
                Put: {
                  TableName: tableName,
                  Item: {
                    ...key,
                    sends: { L: [...recent[index], now.getTime()].map((at) => ({ N: String(at) })) },
                    expiresAt,
                  },
                  ...(observed[index] === undefined
                    ? { ConditionExpression: 'attribute_not_exists(pk)' }
                    : {
                        ConditionExpression: '#sends = :observed',
                        ExpressionAttributeNames: { '#sends': 'sends' },
                        ExpressionAttributeValues: { ':observed': { L: observed[index] } },
                      }),
                },
              })),
            }),
          );
          return true;
        } catch (error) {
          const reasons = cancellationReasons(error);
          if (!reasons || !conditionalCancellation(reasons)) throw error;
          // Somebody else's send landed between the read and the write. Decide again over
          // the list that now stands — the bound is on what is STORED, never on a view.
        }
      }
      throw new Error('Link send allowance changed repeatedly while being spent.');
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
      // A re-send can replace the row between a refused update and its classification read.
      // Retry against the row that NOW stands; never call a fresh challenge "correct"
      // merely because the earlier condition failed for a different one. Address sends are
      // themselves bounded, so eight replacements inside one verification is corruption or
      // deliberate churn; failing closed there is safer than granting a free attempt.
      for (let pass = 0; pass < 8; pass += 1) {
        try {
          // The attempt is counted by a write whose CONDITION is "the code is wrong", so a
          // correct code never spends one — which matters because the confirmation verifies
          // it twice. The count may not be a read-then-write.
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

        const item = await challengeItem(hash);
        if (!item) return { outcome: 'none', attemptsLeft: 0 };
        const attempts = Number(item.attempts?.N ?? '0');
        if (Number(item.expiresAt?.N ?? '0') <= seconds) {
          return { outcome: 'expired', attemptsLeft: 0 };
        }
        if (attempts >= LINK_CODE_MAX_ATTEMPTS) return { outcome: 'spent', attemptsLeft: 0 };
        const heldHash = item.codeHash?.S;
        if (!heldHash) throw new Error('Stored link challenge has no code hash.');
        if (sameDigest(heldHash, codeHash)) {
          return { outcome: 'ok', attemptsLeft: LINK_CODE_MAX_ATTEMPTS - attempts };
        }
        // The read observed a replacement. Loop so this request's wrong attempt is charged
        // to that current challenge rather than returned for free.
      }
      throw new Error('Link challenge changed repeatedly during verification.');
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
      const seconds = Math.floor(Date.parse(input.now) / 1_000);
      try {
        await client.send(
          new TransactWriteItemsCommand({
            ClientRequestToken: requestToken(
              'bind',
              tableName,
              input.accountId,
              input.emailHash,
              input.codeHash,
              input.email,
              input.now,
            ),
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
                  // The account must still exist AND still have its one address slot. Two
                  // different-address binds can pass the route's same snapshot, so the
                  // invariant belongs in this transaction, not in that read.
                  ConditionExpression:
                    'attribute_exists(pk) AND (attribute_not_exists(#email) OR #email = :email)',
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
                  // Verification and consumption name the SAME challenge. A resend after
                  // the read, or another final write consuming it first, refuses the whole
                  // transaction rather than granting the address without its code.
                  ConditionExpression:
                    '#codeHash = :codeHash AND #expiresAt > :now AND #attempts < :max',
                  ExpressionAttributeNames: {
                    '#codeHash': 'codeHash',
                    '#expiresAt': 'expiresAt',
                    '#attempts': 'attempts',
                  },
                  ExpressionAttributeValues: {
                    ':codeHash': { S: input.codeHash },
                    ':now': { N: String(seconds) },
                    ':max': { N: String(LINK_CODE_MAX_ATTEMPTS) },
                  },
                },
              },
            ],
          }),
        );
        return 'bound';
      } catch (error) {
        const reasons = cancellationReasons(error);
        if (!reasons || !conditionalCancellation(reasons)) throw error;
        // Challenge validity wins when more than one condition failed: a binding that won
        // may have consumed it, and the losing request must not turn one code into two
        // final account operations.
        if (reasons[2]?.Code === 'ConditionalCheckFailed') return 'challenge_changed';
        if (reasons[0]?.Code === 'ConditionalCheckFailed') return 'taken';
        if (reasons[1]?.Code === 'ConditionalCheckFailed') return 'account_changed';
        throw error;
      }
    },

    async adopt(input: AccountAdoption): Promise<LinkAdoptResult> {
      const seconds = Math.floor(Date.parse(input.now) / 1_000);
      const identity: TransactWriteItem[] = [
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
          // A binding may outlive corruption, but an adoption may not move a device onto an
          // account that no longer exists.
          ConditionCheck: {
            TableName: tableName,
            Key: { pk: { S: accountKey(input.to) }, sk: { S: ACCOUNT_SORT_KEY } },
            ConditionExpression: 'attribute_exists(pk)',
          },
        },
        {
          // Consuming the challenge inside this transaction is what makes the whole
          // verification one-shot. The condition ties it to what `verify` accepted.
          Delete: {
            TableName: tableName,
            Key: { pk: { S: challengeKey(input.emailHash) }, sk: { S: CHALLENGE_SORT_KEY } },
            ConditionExpression:
              '#codeHash = :codeHash AND #expiresAt > :now AND #attempts < :max',
            ExpressionAttributeNames: {
              '#codeHash': 'codeHash',
              '#expiresAt': 'expiresAt',
              '#attempts': 'attempts',
            },
            ExpressionAttributeValues: {
              ':codeHash': { S: input.codeHash },
              ':now': { N: String(seconds) },
              ':max': { N: String(LINK_CODE_MAX_ATTEMPTS) },
            },
          },
        },
      ];
      if (input.mergeFrom !== undefined) {
        identity.push({
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
        identity.push(
          {
            Delete: {
              TableName: tableName,
              Key: { pk: { S: accountKey(input.from) }, sk: { S: ACCOUNT_SORT_KEY } },
              // `erase` came from an earlier authenticated snapshot. A concurrent bind is
              // allowed to win, but then this account is reachable and may not be deleted.
              ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(#email)',
              ExpressionAttributeNames: { '#email': 'email' },
            },
          },
          {
            Delete: {
              TableName: tableName,
              Key: { pk: { S: profileKey(input.from) }, sk: { S: PROFILE_SORT_KEY } },
            },
          },
        );
      } else {
        // A surviving source must still be live and linked. If another adoption deleted it
        // after the route snapshot, moving this device on the strength of stale state would
        // leave the table with a second unexplained identity transition.
        identity.push({
          ConditionCheck: {
            TableName: tableName,
            Key: { pk: { S: accountKey(input.from) }, sk: { S: ACCOUNT_SORT_KEY } },
            ConditionExpression: 'attribute_exists(pk) AND attribute_exists(#email)',
            ExpressionAttributeNames: { '#email': 'email' },
          },
        });
      }
      const sourceIndex = identity.length - (input.erase ? 2 : 1);

      for (let attempt = 0; attempt < MOVE_PLAN_ATTEMPTS; attempt += 1) {
        // The active day's play, planned by the stores that own the rows and committed HERE,
        // beside the identity — every tuple in parallel, each its own two consistent reads.
        // The score row is planned only for a round that moves: it follows the round it was
        // derived from, never travels alone.
        const plans = await Promise.all(
          (input.moves ?? []).map(async (key) => {
            const round = await planRoundMove(client, tableName, key, input.from, input.to);
            if (!round) return null;
            const score = await planScoreMove(client, tableName, key, input.from, input.to);
            return { key, round, score };
          }),
        );
        const moved: LinkMovedRound[] = [];
        const moves: TransactWriteItem[] = [];
        for (const plan of plans) {
          if (!plan) continue;
          moved.push({ key: plan.key, solved: plan.round.solved });
          moves.push(...plan.round.items, ...plan.score);
        }
        try {
          await client.send(
            new TransactWriteItemsCommand({
              // The plan is part of the token: DynamoDB refuses one token reused with
              // different items, and a re-plan IS different items.
              ClientRequestToken: requestToken(
                'adopt',
                tableName,
                input.tokenHash,
                input.deviceId,
                input.from,
                input.to,
                input.emailHash,
                input.codeHash,
                String(input.erase),
                input.mergeFrom ?? '',
                input.now,
                JSON.stringify(moves),
              ),
              TransactItems: [...identity, ...moves],
            }),
          );
          return { outcome: 'adopted', moved };
        } catch (error) {
          const reasons = cancellationReasons(error);
          if (!reasons || !conditionalCancellation(reasons)) throw error;
          const refused = (index: number) => reasons[index]?.Code === 'ConditionalCheckFailed';
          if (refused(2)) return { outcome: 'challenge_changed', moved: [] };
          if (refused(1) || refused(sourceIndex)) return { outcome: 'account_changed', moved: [] };
          if (refused(0)) return { outcome: 'device_changed', moved: [] };
          // Only a MOVE refused: the play changed between the plan and the commit. Nothing
          // was written — plan again over what stands now, so the guess that landed is
          // carried across rather than deleted unseen.
        }
      }
      throw new Error("The active day's play kept changing while an account was being adopted.");
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
