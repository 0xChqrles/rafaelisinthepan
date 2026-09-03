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
const keySk = (type: string, id: string) => `key#${type}#${id}`;

export interface DurableAuth {
  state: AuthenticationState;
  saveCreds(): Promise<void>;
  // Everything in the keyspace (creds + keys) — the explicit operator reset before a re-pair.
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

  return {
    state,
    async saveCreds() {
      await client.send(
        new PutItemCommand({
          TableName: table,
          Item: { pk: { S: AUTH_PARTITION }, sk: { S: CREDS_SK }, data: serialize(creds) },
        }),
      );
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
        const keys = (page.Items ?? []).map((item) => ({ pk: item.pk!, sk: item.sk! }));
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
