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
import { AUTH_PARTITION, LEASE_SORT_KEY, hasPairedDevice, markAuthInvalidated, readAuthStatus, useDynamoAuthState } from './authStore';
import { initAuthCreds } from 'baileys';

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

describe('is there a session to resume? (#236)', () => {
  it('reads creds.me, NOT the pairing-code-only `registered` flag', () => {
    // Baileys sets `registered` in ONE place — the `link_code_pairing_ref` branch, i.e. the
    // PAIRING-CODE flow — and never reads it. A device linked by QR is fully usable with
    // the flag still false, which is what Baileys itself branches on (`if (!creds.me)`).
    // Gating on `registered` reported `auth.unpaired` forever over a working session.
    expect(hasPairedDevice(initAuthCreds())).toBe(false);
    expect(hasPairedDevice({ me: { id: '33600000000@s.whatsapp.net' } })).toBe(true);
    // The exact production shape: QR-paired, identity assigned, flag never set.
    const qrPaired = { ...initAuthCreds(), me: { id: '33600000000@s.whatsapp.net' }, registered: false };
    expect(qrPaired.registered).toBe(false);
    expect(hasPairedDevice(qrPaired)).toBe(true);
    // Nothing usable in an empty or absent identity.
    expect(hasPairedDevice({})).toBe(false);
    expect(hasPairedDevice({ me: { id: '' } })).toBe(false);
  });
});

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

  it('lands credential snapshots IN ORDER, and drains before a caller exits', async () => {
    const { client, items } = fakeDynamo();
    const send = client.send as unknown as ReturnType<typeof vi.fn>;
    const auth = await useDynamoAuthState(client, 'bot');
    // The first write is slow. Fired concurrently, the second would overtake it and the
    // FIRST — the older snapshot — would land last, walking the stored state backwards.
    let releaseFirst: (() => void) | null = null;
    const real = send.getMockImplementation()!;
    send.mockImplementationOnce(async (command: unknown) => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return real(command);
    });
    auth.state.creds.registered = false;
    const first = auth.saveCreds();
    auth.state.creds.registered = true;
    const second = auth.saveCreds();

    // Let the queue start its first write, which then blocks on the mock.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(items.has('AUTH#bot|creds')).toBe(false); // nothing has landed yet
    releaseFirst!();
    await Promise.all([first, second]);
    await auth.drain();

    // The LAST snapshot asked for is the one stored, whatever the network did.
    expect(JSON.parse(items.get('AUTH#bot|creds')!.data!.S!).registered).toBe(true);
  });

  it('hands a failed write to its own caller and keeps saving after it', async () => {
    const { client, items } = fakeDynamo();
    const send = client.send as unknown as ReturnType<typeof vi.fn>;
    const auth = await useDynamoAuthState(client, 'bot');
    send.mockImplementationOnce(async () => {
      throw new Error('throttled');
    });
    await expect(auth.saveCreds()).rejects.toThrow('throttled');
    auth.state.creds.registered = true;
    await auth.saveCreds();
    await auth.drain();
    expect(JSON.parse(items.get('AUTH#bot|creds')!.data!.S!).registered).toBe(true);
  });

  it('the drain REPORTS a store left behind the socket by a failed LAST write', async () => {
    const { client, items } = fakeDynamo();
    const send = client.send as unknown as ReturnType<typeof vi.fn>;
    const auth = await useDynamoAuthState(client, 'bot');
    await auth.saveCreds();
    // The write that would have registered the device fails, and its own caller — the
    // socket's `creds.update` handler — has already moved on. The drain is the only place
    // a pairing can still learn that the stored session is not the one it just made.
    auth.state.creds.registered = true;
    send.mockImplementationOnce(async () => {
      throw new Error('throttled');
    });
    await expect(auth.saveCreds()).rejects.toThrow('throttled');
    await expect(auth.drain()).rejects.toThrow(/not stored: throttled/);
    expect(JSON.parse(items.get('AUTH#bot|creds')!.data!.S!).registered).toBe(false);
    // A later snapshot that lands puts the store back in step, and the drain says so.
    await auth.saveCreds();
    await expect(auth.drain()).resolves.toBeUndefined();
    expect(JSON.parse(items.get('AUTH#bot|creds')!.data!.S!).registered).toBe(true);
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
