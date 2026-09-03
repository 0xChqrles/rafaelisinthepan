import { describe, expect, it, vi } from 'vitest';
import {
  BatchGetItemCommand,
  BatchWriteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  type AttributeValue,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  AUTH_PARTITION,
  LEASE_SORT_KEY,
  markAuthInvalidated,
  readAuthStatus,
  useDynamoAuthState,
} from './authStore';

// A tiny in-memory DynamoDB: enough of Get/Put/BatchGet/BatchWrite for the auth keyspace.
function fakeDynamo() {
  const items = new Map<string, Record<string, AttributeValue>>();
  const k = (key: Record<string, AttributeValue>) => `${key.pk.S}|${key.sk.S}`;
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof GetItemCommand) {
      return { Item: items.get(k(command.input.Key!)) };
    }
    if (command instanceof PutItemCommand) {
      items.set(k(command.input.Item!), command.input.Item!);
      return {};
    }
    if (command instanceof QueryCommand) {
      const pk = (command.input.ExpressionAttributeValues![':pk'] as { S: string }).S;
      return { Items: [...items.values()].filter((item) => item.pk.S === pk) };
    }
    if (command instanceof BatchGetItemCommand) {
      const [table, { Keys }] = Object.entries(command.input.RequestItems!)[0];
      return { Responses: { [table]: Keys!.map((key) => items.get(k(key))).filter(Boolean) } };
    }
    if (command instanceof BatchWriteItemCommand) {
      const [, writes] = Object.entries(command.input.RequestItems!)[0];
      for (const w of writes) {
        if (w.PutRequest) items.set(k(w.PutRequest.Item!), w.PutRequest.Item!);
        if (w.DeleteRequest) items.delete(k(w.DeleteRequest.Key!));
      }
      return {};
    }
    throw new Error(`unexpected ${String(command)}`);
  });
  return { client: { send } as unknown as DynamoDBClient, items };
}

describe('durable Baileys auth state (#236)', () => {
  it('starts fresh, persists creds, and reloads them byte-identical (Buffers included)', async () => {
    const { client, items } = fakeDynamo();
    const first = await useDynamoAuthState(client, 'bot');
    expect(first.state.creds.registered).toBe(false);
    expect(first.state.creds.noiseKey.public).toBeInstanceOf(Uint8Array);
    first.state.creds.registered = true;
    await first.saveCreds();
    expect(items.has('AUTH#bot|creds')).toBe(true);

    const second = await useDynamoAuthState(client, 'bot');
    expect(second.state.creds.registered).toBe(true);
    expect(Buffer.from(second.state.creds.noiseKey.private)).toEqual(
      Buffer.from(first.state.creds.noiseKey.private),
    );
  });

  it('stores signal keys per (type, id), reads them back, and deletes on null', async () => {
    const { client, items } = fakeDynamo();
    const auth = await useDynamoAuthState(client, 'bot');
    const session = Buffer.from([1, 2, 3]);
    await auth.state.keys.set({
      session: { 'a@s.whatsapp.net': session, 'b@s.whatsapp.net': Buffer.from([9]) },
      'sender-key-memory': { 'g@g.us': { 'a@s.whatsapp.net': true } },
    });
    expect(items.has('AUTH#bot|key#session#a@s.whatsapp.net')).toBe(true);
    const got = await auth.state.keys.get('session', ['a@s.whatsapp.net', 'missing']);
    expect(Buffer.from(got['a@s.whatsapp.net'])).toEqual(session);
    expect(got.missing).toBeUndefined();
    expect(await auth.state.keys.get('sender-key-memory', ['g@g.us'])).toEqual({
      'g@g.us': { 'a@s.whatsapp.net': true },
    });
    await auth.state.keys.set({ session: { 'a@s.whatsapp.net': null } });
    expect(items.has('AUTH#bot|key#session#a@s.whatsapp.net')).toBe(false);
  });

  it('invalidation is a flag beside the state, never an erase', async () => {
    const { client, items } = fakeDynamo();
    const auth = await useDynamoAuthState(client, 'bot');
    await auth.saveCreds();
    expect(await readAuthStatus(client, 'bot')).toEqual({ invalidated: false });
    await markAuthInvalidated(client, 'bot', 'loggedOut', new Date('2026-09-03T00:00:00Z'));
    expect(await readAuthStatus(client, 'bot')).toEqual({
      invalidated: true,
      at: '2026-09-03T00:00:00.000Z',
      reason: 'loggedOut',
    });
    expect(items.has('AUTH#bot|creds')).toBe(true);
  });

  it('wipe clears the session and KEEPS the lease its caller is holding', async () => {
    const { client, items } = fakeDynamo();
    const auth = await useDynamoAuthState(client, 'bot');
    await auth.saveCreds();
    await auth.state.keys.set({ session: { 'a@s.whatsapp.net': Buffer.from([1]) } });
    await markAuthInvalidated(client, 'bot', 'loggedOut');
    const lease = { pk: { S: AUTH_PARTITION }, sk: { S: LEASE_SORT_KEY }, owner: { S: 'pair#1' } };
    items.set(`${AUTH_PARTITION}|${LEASE_SORT_KEY}`, lease);

    await auth.wipe();

    expect(items.has('AUTH#bot|creds')).toBe(false);
    expect(items.has('AUTH#bot|key#session#a@s.whatsapp.net')).toBe(false);
    expect(items.has('AUTH#bot|status')).toBe(false);
    // Deleting it would let a second process open a competing socket mid-pairing, with the
    // holder's renewals failing unnoticed.
    expect(items.get(`${AUTH_PARTITION}|${LEASE_SORT_KEY}`)).toEqual(lease);
  });
});
