// Durable Baileys auth state in the bot's DynamoDB table (#236): the credentials and every
// Signal key, under the `AUTH#bot` keyspace — device state with no group dimension.
// Container-local files are never an authority: the task loads this before opening the
// socket, persists every `creds.update` and key mutation through it, and a replacement
// task reconnects without pairing again.
//
// Values are stored as JSON through Baileys' own `BufferJSON` (its Buffer encoding), so a
// round trip yields exactly the objects the socket handed over. The same store serves the
// operator's pairing CLI, which is how a pairing made on a laptop is what Fargate resumes.
//
// INVALIDATION IS A FLAG, NOT AN ERASE: when WhatsApp logs the device out, the task marks
// the state invalidated and stops. Nothing is deleted and nothing is re-minted — re-pairing
// is an explicit operator act (`pnpm bot:pair`), which clears the flag.

import {
  BatchGetItemCommand,
  BatchWriteItemCommand,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  type AttributeValue,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from 'baileys';

export const AUTH_PARTITION = 'AUTH#bot';
const CREDS_SK = 'creds';
const STATUS_SK = 'status';
// The single-session lease (`lease.ts`) lives in this partition too. Its name is declared
// HERE, with the partition's other sort keys, so `wipe()` below can exclude it by name —
// and so the two files cannot drift into a cycle over one string.
export const LEASE_SORT_KEY = 'lease';
const keySk = (type: string, id: string) => `key#${type}#${id}`;

export interface DurableAuth {
  state: AuthenticationState;
  // Snapshots the credentials NOW and queues the write. Snapshot-at-call plus a strict
  // queue is what keeps the stored state monotonic — see the implementation.
  saveCreds(): Promise<void>;
  // Resolves once every queued snapshot has SETTLED. The socket fires `creds.update` and
  // moves on, so without a drain a shutdown (or the pairing CLI exiting) can leave the
  // last one — the one that registered the device — unwritten. It never rejects: each
  // write's own outcome belongs to the `saveCreds()` that asked for it.
  drain(): Promise<void>;
  // The session state (creds + Signal keys + the invalidation flag) — the explicit
  // operator reset before a re-pair. It KEEPS the lease: the caller is holding it while
  // wiping, and deleting it would leave the pairing to run unleashed (renewing against a
  // row that no longer exists fails forever, so nothing would notice) with a second
  // process free to open a competing socket mid-pair.
  wipe(): Promise<void>;
}

export interface AuthStatus {
  invalidated: boolean;
  at?: string;
  reason?: string;
}

function serialize(value: unknown): AttributeValue {
  return { S: JSON.stringify(value, BufferJSON.replacer) };
}

function deserialize<T>(attr: AttributeValue | undefined): T | null {
  if (!attr?.S) return null;
  return JSON.parse(attr.S, BufferJSON.reviver) as T;
}

export async function readAuthStatus(client: DynamoDBClient, table: string): Promise<AuthStatus> {
  const item = (
    await client.send(
      new GetItemCommand({
        TableName: table,
        Key: { pk: { S: AUTH_PARTITION }, sk: { S: STATUS_SK } },
        ConsistentRead: true,
      }),
    )
  ).Item;
  if (!item) return { invalidated: false };
  return {
    invalidated: item.invalidated?.BOOL === true,
    at: item.at?.S,
    reason: item.reason?.S,
  };
}

export async function markAuthInvalidated(
  client: DynamoDBClient,
  table: string,
  reason: string,
  now = new Date(),
): Promise<void> {
  await client.send(
    new PutItemCommand({
      TableName: table,
      Item: {
        pk: { S: AUTH_PARTITION },
        sk: { S: STATUS_SK },
        invalidated: { BOOL: true },
        at: { S: now.toISOString() },
        reason: { S: reason },
      },
    }),
  );
}

export async function clearAuthInvalidated(client: DynamoDBClient, table: string): Promise<void> {
  await client.send(
    new DeleteItemCommand({
      TableName: table,
      Key: { pk: { S: AUTH_PARTITION }, sk: { S: STATUS_SK } },
    }),
  );
}

export async function useDynamoAuthState(client: DynamoDBClient, table: string): Promise<DurableAuth> {
  const stored = (
    await client.send(
      new GetItemCommand({
        TableName: table,
        Key: { pk: { S: AUTH_PARTITION }, sk: { S: CREDS_SK } },
        ConsistentRead: true,
      }),
    )
  ).Item;
  const creds: AuthenticationCreds = deserialize<AuthenticationCreds>(stored?.data) ?? initAuthCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      async get(type, ids) {
        const out: { [id: string]: SignalDataTypeMap[typeof type] } = {};
        const unique = [...new Set(ids)];
        for (let i = 0; i < unique.length; i += 100) {
          let keys: Record<string, AttributeValue>[] = unique
            .slice(i, i + 100)
            .map((id) => ({ pk: { S: AUTH_PARTITION }, sk: { S: keySk(type, id) } }));
          while (keys.length > 0) {
            const response = await client.send(
              new BatchGetItemCommand({
                RequestItems: { [table]: { Keys: keys, ConsistentRead: true } },
              }),
            );
            for (const item of response.Responses?.[table] ?? []) {
              const id = item.sk?.S?.slice(keySk(type, '').length) ?? '';
              let value = deserialize<unknown>(item.data);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
              }
              if (value !== null) out[id] = value as SignalDataTypeMap[typeof type];
            }
            keys = response.UnprocessedKeys?.[table]?.Keys ?? [];
          }
        }
        return out;
      },
      async set(data) {
        const writes: { PutRequest?: { Item: Record<string, AttributeValue> }; DeleteRequest?: { Key: Record<string, AttributeValue> } }[] = [];
        for (const type of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
          for (const [id, value] of Object.entries(data[type] ?? {})) {
            const key = { pk: { S: AUTH_PARTITION }, sk: { S: keySk(type, id) } };
            writes.push(
              value
                ? { PutRequest: { Item: { ...key, data: serialize(value) } } }
                : { DeleteRequest: { Key: key } },
            );
          }
        }
        for (let i = 0; i < writes.length; i += 25) {
          let batch = writes.slice(i, i + 25);
          while (batch.length > 0) {
            const response = await client.send(
              new BatchWriteItemCommand({ RequestItems: { [table]: batch } }),
            );
            batch = (response.UnprocessedItems?.[table] ?? []) as typeof batch;
          }
        }
      },
    },
  };

  // CREDENTIAL WRITES ARE SERIALIZED, and it is a correctness rule rather than tidiness.
  // `creds` is ONE mutable object Baileys edits in place, and every `creds.update` writes
  // the WHOLE of it. Fired concurrently, two writes race, and the loser is whichever the
  // network delivers last — so an OLDER snapshot can land on top of a newer one and the
  // stored state goes BACKWARDS. What that costs is exactly what durable auth exists to
  // buy: a task that restarts onto a half-registered session and has to be paired again.
  // Each call snapshots at CALL time and joins the queue, so the writes land in the order
  // they were asked for and the last one to land is the newest.
  let queue: Promise<void> = Promise.resolve();

  return {
    state,
    saveCreds() {
      const snapshot = serialize(creds);
      queue = queue.then(async () => {
        await client.send(
          new PutItemCommand({
            TableName: table,
            Item: { pk: { S: AUTH_PARTITION }, sk: { S: CREDS_SK }, data: snapshot },
          }),
        );
      });
      // A failed write must not poison the queue for every save after it: the caller is
      // handed this attempt's rejection, and the chain carries on from a settled promise.
      const attempt = queue;
      queue = queue.catch(() => {});
      return attempt;
    },
    async drain() {
      await queue;
    },
    async wipe() {
      // The keyspace is small (creds + a few hundred keys); paged Query + batched deletes.
      const { QueryCommand } = await import('@aws-sdk/client-dynamodb');
      let cursor: Record<string, AttributeValue> | undefined;
      do {
        const page = await client.send(
          new QueryCommand({
            TableName: table,
            KeyConditionExpression: '#pk = :pk',
            ExpressionAttributeNames: { '#pk': 'pk' },
            ExpressionAttributeValues: { ':pk': { S: AUTH_PARTITION } },
            ProjectionExpression: 'pk, sk',
            ...(cursor ? { ExclusiveStartKey: cursor } : {}),
          }),
        );
        const keys = (page.Items ?? [])
          .filter((item) => item.sk?.S !== LEASE_SORT_KEY)
          .map((item) => ({ pk: item.pk!, sk: item.sk! }));
        for (let i = 0; i < keys.length; i += 25) {
          let batch = keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }));
          while (batch.length > 0) {
            const response = await client.send(
              new BatchWriteItemCommand({ RequestItems: { [table]: batch } }),
            );
            batch = (response.UnprocessedItems?.[table] ?? []) as typeof batch;
          }
        }
        cursor = page.LastEvaluatedKey;
      } while (cursor);
    },
  };
}
