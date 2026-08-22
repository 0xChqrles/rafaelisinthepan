import { describe, expect, it } from 'vitest';
import { publicIdFromSecret } from '@whippin/shared';
import { createHandler } from './handler';
import { FRIENDS_MAX, type FriendStore } from './friendStore';
import { memoryFriendStore } from './memoryFriendStore';
import type { FnUrlEvent } from './respond';
import type { PuzzleStore } from './store';

const SECRET = 'a'.repeat(32);
const OTHER_SECRET = 'b'.repeat(32);

const emptyStore: PuzzleStore = {
  getPuzzle: async () => null,
  getWordPuzzle: async () => null,
  getSlice: async () => null,
};

function makeHandler(friends: FriendStore = memoryFriendStore()) {
  return { friends, handler: createHandler({ store: emptyStore, friends }) };
}

function post(body: unknown): FnUrlEvent {
  return {
    rawPath: '/friends',
    requestContext: { http: { method: 'POST' } },
    body: JSON.stringify(body),
  };
}

// A distinct, well-formed publicId per index — the base32 alphabet identity.ts derives
// into, so these are ids the route accepts without deriving 200 real secrets.
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

async function listOf(handler: ReturnType<typeof createHandler>, secret: string) {
  const result = await handler(post({ secret }));
  expect(result.statusCode).toBe(200);
  return (JSON.parse(result.body) as { friends: string[] }).friends;
}

describe('friends route (#189)', () => {
  it('records the edge in BOTH directions from ONE click', async () => {
    const { handler } = makeHandler();
    const me = await publicIdFromSecret(SECRET);
    const them = await publicIdFromSecret(OTHER_SECRET);

    // The clicker is the only device present, and the write still benefits both sides —
    // the whole reason the graph is server-side.
    const result = await handler(post({ secret: SECRET, add: them }));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ friends: [them] });
    await expect(listOf(handler, OTHER_SECRET)).resolves.toEqual([me]);
  });

  it('removes the edge for BOTH sides, from either side', async () => {
    const { handler } = makeHandler();
    const me = await publicIdFromSecret(SECRET);
    const them = await publicIdFromSecret(OTHER_SECRET);
    await handler(post({ secret: SECRET, add: them }));

    // The side that did NOT create the link can end it, and it ends for both.
    const result = await handler(post({ secret: OTHER_SECRET, remove: me }));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ friends: [] });
    await expect(listOf(handler, SECRET)).resolves.toEqual([]);
  });

  it('is idempotent on a re-click: one edge, the original instant, no error', async () => {
    const { friends, handler } = makeHandler();
    const me = await publicIdFromSecret(SECRET);
    const them = await publicIdFromSecret(OTHER_SECRET);
    await handler(post({ secret: SECRET, add: them }));
    const again = await handler(post({ secret: SECRET, add: them }));

    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.body)).toEqual({ friends: [them] });
    await expect(listOf(handler, OTHER_SECRET)).resolves.toEqual([me]);
    // A pair already linked is reported as such — the CALLER's list is unchanged, which is
    // not the same claim as "nothing was written": both rows go out on every accepted link
    // so a missing other half repairs from either side.
    await expect(
      friends.link({ publicId: me, friendId: them, createdAt: '2026-08-19T00:00:00.000Z' }),
    ).resolves.toEqual({ outcome: 'already_linked', friends: [them] });
  });

  it('removing someone who is not a friend changes nothing and is not an error', async () => {
    const { handler } = makeHandler();
    const result = await handler(post({ secret: SECRET, remove: fakeId(7) }));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ friends: [] });
  });

  it('refuses a self-add: opening your own invite link is a mistaken click', async () => {
    const { handler } = makeHandler();
    const me = await publicIdFromSecret(SECRET);
    const result = await handler(post({ secret: SECRET, add: me }));
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('self_link');
    await expect(listOf(handler, SECRET)).resolves.toEqual([]);
  });

  it('caps a player at FRIENDS_MAX — on their OWN side and on the other side alike', async () => {
    const { friends, handler } = makeHandler();
    const me = await publicIdFromSecret(SECRET);
    const them = await publicIdFromSecret(OTHER_SECRET);
    for (let i = 0; i < FRIENDS_MAX; i += 1) {
      await friends.link({ publicId: me, friendId: fakeId(i), createdAt: '2026-08-19T00:00:00.000Z' });
    }

    const full = await handler(post({ secret: SECRET, add: them }));
    expect(full.statusCode).toBe(409);
    expect(JSON.parse(full.body).error).toBe('friend_limit');

    // And from the other direction: a publicly posted link is exactly how a SENDER's own
    // list would run away from them, so the cap has to bind whoever is full.
    const other = await handler(post({ secret: OTHER_SECRET, add: me }));
    expect(other.statusCode).toBe(409);
    expect(JSON.parse(other.body).error).toBe('friend_limit');
    await expect(listOf(handler, OTHER_SECRET)).resolves.toEqual([]);
  });

  it('still lets a capped player re-open a link they already accepted', async () => {
    const { friends, handler } = makeHandler();
    const me = await publicIdFromSecret(SECRET);
    for (let i = 0; i < FRIENDS_MAX; i += 1) {
      await friends.link({ publicId: me, friendId: fakeId(i), createdAt: '2026-08-19T00:00:00.000Z' });
    }
    const again = await handler(post({ secret: SECRET, add: fakeId(0) }));
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.body).friends).toHaveLength(FRIENDS_MAX);
  });

  it('answers only the caller their OWN graph, and only with a real key', async () => {
    const { handler } = makeHandler();
    const them = await publicIdFromSecret(OTHER_SECRET);
    await handler(post({ secret: SECRET, add: them }));

    // The list is derived from the secret; there is no id parameter to ask with.
    await expect(listOf(handler, OTHER_SECRET)).resolves.toHaveLength(1);
    const anonymous = await handler(post({}));
    expect(anonymous.statusCode).toBe(400);
    const malformed = await handler(post({ secret: 'not-a-key', add: them }));
    expect(malformed.statusCode).toBe(400);
  });

  it('rejects a malformed target, a body naming both operations, and a GET', async () => {
    const { handler } = makeHandler();
    const them = await publicIdFromSecret(OTHER_SECRET);
    expect((await handler(post({ secret: SECRET, add: 'nope' }))).statusCode).toBe(400);
    expect((await handler(post({ secret: SECRET, remove: 42 }))).statusCode).toBe(400);
    expect(
      (await handler(post({ secret: SECRET, add: them, remove: them }))).statusCode,
    ).toBe(400);

    const read = await handler({
      rawPath: '/friends',
      requestContext: { http: { method: 'GET' } },
    });
    expect(read.statusCode).toBe(405);
  });

  it('never caches the graph', async () => {
    const { handler } = makeHandler();
    const result = await handler(post({ secret: SECRET }));
    expect(result.headers['Cache-Control']).toBe('no-store');
  });
});
