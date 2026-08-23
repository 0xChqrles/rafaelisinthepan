import { describe, expect, it } from 'vitest';
import { createHandler } from './handler';
import { FRIENDS_MAX, type FriendStore } from './friendStore';
import { memoryDeviceStore } from './memoryDeviceStore';
import { memoryFriendStore } from './memoryFriendStore';
import type { FnUrlEvent } from './respond';
import type { PuzzleStore } from './store';
import { seedDevice, type TestDevice } from './testDevice';

const emptyStore: PuzzleStore = {
  getPuzzle: async () => null,
  getWordPuzzle: async () => null,
  getSlice: async () => null,
};

// Two devices on two accounts — the shape every case here needs: the caller and the person
// on the other end of the invite link. Since #216 an identity is a STORED pair, so the two
// are seeded rather than spelled.
async function makeHandler(friends: FriendStore = memoryFriendStore()) {
  const devices = memoryDeviceStore();
  const handler = createHandler({
    store: emptyStore,
    friends,
    devices: { deviceStore: devices, turnstile: { verify: async () => true }, allowSourceIp: true },
  });
  const me = await seedDevice(devices);
  const them = await seedDevice(devices);
  return { friends, handler, devices, me, them };
}

function post(body: unknown): FnUrlEvent {
  return {
    rawPath: '/friends',
    requestContext: { http: { method: 'POST' } },
    body: JSON.stringify(body),
  };
}

// A distinct, well-formed publicId per index — the base32 alphabet identity.ts mints into,
// so these are ids the route accepts without seeding 200 real accounts.
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
function fakeId(n: number): string {
  let out = '';
  let value = n;
  for (let i = 0; i < 16; i += 1) {
    out = BASE32[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

async function listOf(handler: ReturnType<typeof createHandler>, device: TestDevice) {
  const result = await handler(post({ token: device.token }));
  expect(result.statusCode).toBe(200);
  return (JSON.parse(result.body) as { friends: string[] }).friends;
}

describe('friends route (#189)', () => {
  it('records the edge in BOTH directions from ONE click', async () => {
    const { handler, me, them } = await makeHandler();

    // The clicker is the only device present, and the write still benefits both sides —
    // the whole reason the graph is server-side.
    const result = await handler(post({ token: me.token, add: them.accountId }));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ friends: [them.accountId] });
    await expect(listOf(handler, them)).resolves.toEqual([me.accountId]);
  });

  it('removes the edge for BOTH sides, from either side', async () => {
    const { handler, me, them } = await makeHandler();
    await handler(post({ token: me.token, add: them.accountId }));

    // The side that did NOT create the link can end it, and it ends for both.
    const result = await handler(post({ token: them.token, remove: me.accountId }));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ friends: [] });
    await expect(listOf(handler, me)).resolves.toEqual([]);
  });

  it('is idempotent on a re-click: one edge, the original instant, no error', async () => {
    const { friends, handler, me, them } = await makeHandler();
    await handler(post({ token: me.token, add: them.accountId }));
    const again = await handler(post({ token: me.token, add: them.accountId }));

    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.body)).toEqual({ friends: [them.accountId] });
    await expect(listOf(handler, them)).resolves.toEqual([me.accountId]);
    // A pair already linked is reported as such — the CALLER's list is unchanged, which is
    // not the same claim as "nothing was written": both rows go out on every accepted link
    // so a missing other half repairs from either side.
    await expect(
      friends.link({
        publicId: me.accountId,
        friendId: them.accountId,
        createdAt: '2026-08-19T00:00:00.000Z',
      }),
    ).resolves.toEqual({ outcome: 'already_linked', friends: [them.accountId] });
  });

  it('removing someone who is not a friend changes nothing and is not an error', async () => {
    const { handler, me } = await makeHandler();
    const result = await handler(post({ token: me.token, remove: fakeId(7) }));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ friends: [] });
  });

  it('refuses a self-add: opening your own invite link is a mistaken click', async () => {
    const { handler, me } = await makeHandler();
    const result = await handler(post({ token: me.token, add: me.accountId }));
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('self_link');
    await expect(listOf(handler, me)).resolves.toEqual([]);
  });

  it('caps a player at FRIENDS_MAX — on their OWN side and on the other side alike', async () => {
    const { friends, handler, me, them } = await makeHandler();
    for (let i = 0; i < FRIENDS_MAX; i += 1) {
      await friends.link({
        publicId: me.accountId,
        friendId: fakeId(i),
        createdAt: '2026-08-19T00:00:00.000Z',
      });
    }

    const full = await handler(post({ token: me.token, add: them.accountId }));
    expect(full.statusCode).toBe(409);
    expect(JSON.parse(full.body).error).toBe('friend_limit');

    // And from the other direction: a publicly posted link is exactly how a SENDER's own
    // list would run away from them, so the cap has to bind whoever is full.
    const other = await handler(post({ token: them.token, add: me.accountId }));
    expect(other.statusCode).toBe(409);
    expect(JSON.parse(other.body).error).toBe('friend_limit');
    await expect(listOf(handler, them)).resolves.toEqual([]);
  });

  it('still lets a capped player re-open a link they already accepted', async () => {
    const { friends, handler, me } = await makeHandler();
    for (let i = 0; i < FRIENDS_MAX; i += 1) {
      await friends.link({
        publicId: me.accountId,
        friendId: fakeId(i),
        createdAt: '2026-08-19T00:00:00.000Z',
      });
    }
    const again = await handler(post({ token: me.token, add: fakeId(0) }));
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.body).friends).toHaveLength(FRIENDS_MAX);
  });

  it('answers only the caller their OWN graph, and only with a real device', async () => {
    const { handler, me, them } = await makeHandler();
    await handler(post({ token: me.token, add: them.accountId }));

    // The list is resolved from the device token; there is no id parameter to ask with.
    await expect(listOf(handler, them)).resolves.toHaveLength(1);
    const anonymous = await handler(post({}));
    expect(anonymous.statusCode).toBe(400);
    const malformed = await handler(post({ token: 'not-a-token', add: them.accountId }));
    expect(malformed.statusCode).toBe(400);
  });

  it('answers a well-formed token nobody holds with unknown_device (#216)', async () => {
    const { handler, them } = await makeHandler();
    // Well-formed and canonical, but no device item was ever created for it. It must be
    // told so — never quietly given a fresh identity, which is what would let a revoked
    // device keep playing under a new account on its next write.
    const stranger = await handler(post({ token: 'f'.repeat(64), add: them.accountId }));
    expect(stranger.statusCode).toBe(401);
    expect(JSON.parse(stranger.body).error).toBe('unknown_device');
  });

  it('rejects a malformed target, a body naming both operations, and a GET', async () => {
    const { handler, me, them } = await makeHandler();
    expect((await handler(post({ token: me.token, add: 'nope' }))).statusCode).toBe(400);
    expect((await handler(post({ token: me.token, remove: 42 }))).statusCode).toBe(400);
    expect(
      (await handler(post({ token: me.token, add: them.accountId, remove: them.accountId })))
        .statusCode,
    ).toBe(400);

    const read = await handler({
      rawPath: '/friends',
      requestContext: { http: { method: 'GET' } },
    });
    expect(read.statusCode).toBe(405);
  });

  it('never caches the graph', async () => {
    const { handler, me } = await makeHandler();
    const result = await handler(post({ token: me.token }));
    expect(result.headers['Cache-Control']).toBe('no-store');
  });
});
