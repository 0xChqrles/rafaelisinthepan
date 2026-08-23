import {
  DeleteItemCommand,
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  ACCOUNT_SORT_KEY,
  DEVICE_INDEX_NAME,
  DEVICE_SORT_KEY,
  accountKey,
  deviceIndexKey,
  deviceIndexSortKey,
  deviceKey,
  type AccountRecord,
  type DeviceAgent,
  type DeviceRecord,
  type DeviceStore,
} from './deviceStore';

// Production device and account rows live in the score table (#216).
//
// AUTHENTICATION is one GetItem on `device#<tokenHash>` plus one on the account row — the
// only two reads a private call adds, and both are tiny single items. It is STRONGLY
// CONSISTENT for the profile read's reason: a device that just bootstrapped immediately
// makes an authenticated call with the token it was handed, and an eventually-consistent
// miss there reads as `unknown_device` — the one answer that signs a player out.
//
// The GSI is deliberately NOT on that path. It exists for the sign-out screen, where a lag
// after a create or a delete is a cosmetic list delay; it can never keep a revoked token
// authenticable, because revocation deletes the token's own base item.
function agentOf(item: Record<string, AttributeValue>): DeviceAgent {
  const agent = item.agent?.M ?? {};
  return {
    device: agent.device?.S ?? '',
    os: agent.os?.S ?? '',
    browser: agent.browser?.S ?? '',
  };
}

function deviceOf(item: Record<string, AttributeValue>): DeviceRecord | null {
  const deviceId = item.deviceId?.S;
  const accountId = item.accountId?.S;
  if (!deviceId || !accountId) return null;
  return {
    deviceId,
    accountId,
    agent: agentOf(item),
    createdAt: item.createdAt?.S ?? '',
    lastSeenAt: item.lastSeenAt?.S ?? '',
  };
}

export function dynamoDeviceStore(client: DynamoDBClient, tableName: string): DeviceStore {
  async function account(accountId: string): Promise<AccountRecord | null> {
    const response = await client.send(
      new GetItemCommand({
        TableName: tableName,
        Key: { pk: { S: accountKey(accountId) }, sk: { S: ACCOUNT_SORT_KEY } },
        ConsistentRead: true,
      }),
    );
    if (!response.Item) return null;
    return { accountId, createdAt: response.Item.createdAt?.S ?? '' };
  }

  async function device(tokenHash: string): Promise<DeviceRecord | null> {
    const response = await client.send(
      new GetItemCommand({
        TableName: tableName,
        Key: { pk: { S: deviceKey(tokenHash) }, sk: { S: DEVICE_SORT_KEY } },
        ConsistentRead: true,
      }),
    );
    return response.Item ? deviceOf(response.Item) : null;
  }

  async function resolve(tokenHash: string) {
    const found = await device(tokenHash);
    if (!found) return null;
    const live = await account(found.accountId);
    // A device item an account deletion missed must not keep authenticating — that is the
    // whole reason the check is here rather than trusted to the sweep.
    if (!live) return null;
    return { device: found, account: live };
  }

  // The ONE item to delete, found through the index. The account partition is the caller's
  // own, so this can only ever surface their devices.
  async function baseKeyOf(accountId: string, deviceId: string): Promise<string | null> {
    const response = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: DEVICE_INDEX_NAME,
        KeyConditionExpression: '#pk = :pk AND #sk = :sk',
        ExpressionAttributeNames: { '#pk': 'gsi1pk', '#sk': 'gsi1sk' },
        ExpressionAttributeValues: {
          ':pk': { S: deviceIndexKey(accountId) },
          ':sk': { S: deviceIndexSortKey(deviceId) },
        },
        // A GSI Query is eventually consistent BY DESIGN — DynamoDB refuses ConsistentRead
        // on a global index — so a device created moments ago may not be listed yet. That
        // is the cosmetic lag this index is allowed to have; the delete below is still
        // conditional, so a STALE row cannot delete anything that no longer matches.
      }),
    );
    return response.Items?.[0]?.pk?.S ?? null;
  }

  return {
    resolve,

    async bootstrap(input) {
      // Idempotent by token hash: a lost answer after a committed write must return what
      // was created rather than mint a second identity. The read comes first because that
      // is the common retry, and because a device whose ACCOUNT is gone must answer as the
      // unknown device it is rather than quietly acquire a fresh account.
      const existing = await device(input.tokenHash);
      if (existing) {
        const live = await account(existing.accountId);
        if (!live) {
          throw new Error('bootstrap: the device exists but its account is gone.');
        }
        return { device: existing, account: live };
      }

      const item: Record<string, AttributeValue> = {
        pk: { S: deviceKey(input.tokenHash) },
        sk: { S: DEVICE_SORT_KEY },
        // The index keys are ordinary attributes; only items carrying BOTH are in the
        // sparse index, which is every device row and nothing else on this table.
        gsi1pk: { S: deviceIndexKey(input.accountId) },
        gsi1sk: { S: deviceIndexSortKey(input.deviceId) },
        deviceId: { S: input.deviceId },
        accountId: { S: input.accountId },
        agent: {
          M: {
            device: { S: input.agent.device },
            os: { S: input.agent.os },
            browser: { S: input.agent.browser },
          },
        },
        createdAt: { S: input.now },
        lastSeenAt: { S: input.now },
      };

      try {
        // ONE transaction: an account with no device is unreachable and a device with no
        // account is unauthenticable, so the pair is written indivisibly. Both puts are
        // create-only, which is what makes a racing second bootstrap of the same token
        // fail rather than overwrite the identity that won.
        await client.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Put: {
                  TableName: tableName,
                  Item: {
                    pk: { S: accountKey(input.accountId) },
                    sk: { S: ACCOUNT_SORT_KEY },
                    createdAt: { S: input.now },
                  },
                  ConditionExpression: 'attribute_not_exists(pk)',
                },
              },
              {
                Put: {
                  TableName: tableName,
                  Item: item,
                  ConditionExpression: 'attribute_not_exists(pk)',
                },
              },
            ],
          }),
        );
      } catch (error) {
        // A concurrent bootstrap of the SAME token committed first (two tabs, a retry that
        // overtook its own request). Its identity is the one that exists, so adopt it —
        // minting another here is exactly the duplicate identity the idempotence is for.
        const raced = await resolve(input.tokenHash);
        if (raced) return raced;
        throw error;
      }

      return {
        device: {
          deviceId: input.deviceId,
          accountId: input.accountId,
          agent: input.agent,
          createdAt: input.now,
          lastSeenAt: input.now,
        },
        account: { accountId: input.accountId, createdAt: input.now },
      };
    },

    async list(accountId) {
      const devices: DeviceRecord[] = [];
      let cursor: Record<string, AttributeValue> | undefined;
      do {
        const response = await client.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: DEVICE_INDEX_NAME,
            KeyConditionExpression: '#pk = :pk',
            ExpressionAttributeNames: { '#pk': 'gsi1pk' },
            ExpressionAttributeValues: { ':pk': { S: deviceIndexKey(accountId) } },
            ...(cursor ? { ExclusiveStartKey: cursor } : {}),
          }),
        );
        for (const item of response.Items ?? []) {
          const record = deviceOf(item);
          if (record) devices.push(record);
        }
        cursor = response.LastEvaluatedKey;
      } while (cursor);
      // The index sorts by `device#<deviceId>` already; sorting again keeps the list stable
      // across pages and identical to the memory store's.
      return devices.sort((a, b) =>
        a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0,
      );
    },

    async revoke(accountId, deviceId) {
      const pk = await baseKeyOf(accountId, deviceId);
      if (!pk) return false;
      try {
        await client.send(
          new DeleteItemCommand({
            TableName: tableName,
            Key: { pk: { S: pk }, sk: { S: DEVICE_SORT_KEY } },
            // The index answer may be STALE — the row may already be gone, or may since
            // have been re-bootstrapped under another account — so the delete names what it
            // expects. Without it, a lagging index is a way to delete somebody else's
            // device item.
            ConditionExpression: '#accountId = :accountId AND #deviceId = :deviceId',
            ExpressionAttributeNames: { '#accountId': 'accountId', '#deviceId': 'deviceId' },
            ExpressionAttributeValues: {
              ':accountId': { S: accountId },
              ':deviceId': { S: deviceId },
            },
          }),
        );
        return true;
      } catch {
        // A failed condition is an honest "nothing was removed", never an error to surface:
        // the caller asked to sign out a device that is already gone.
        return false;
      }
    },

    async touch(tokenHash, now) {
      try {
        await client.send(
          new UpdateItemCommand({
            TableName: tableName,
            Key: { pk: { S: deviceKey(tokenHash) }, sk: { S: DEVICE_SORT_KEY } },
            UpdateExpression: 'SET #lastSeenAt = :now',
            // Only ever an EXISTING device: a bare update would resurrect a revoked token's
            // item as a row with no account and no ids — unauthenticable, but a row.
            ConditionExpression: 'attribute_exists(pk)',
            ExpressionAttributeNames: { '#lastSeenAt': 'lastSeenAt' },
            ExpressionAttributeValues: { ':now': { S: now } },
          }),
        );
      } catch {
        // The device was revoked between this request's authentication and its stamp. That
        // is not a failure of the call the player made: `lastSeenAt` is a label on a
        // sign-out screen, and refusing the whole request over it would turn a race into an
        // error the player sees.
      }
    },
  };
}
