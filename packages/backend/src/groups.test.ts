import { describe, expect, it } from 'vitest';
import { GROUP_MEMBERS_MAX, GROUPS_MAX, type GroupSummary } from '@whippin/shared';
import { createHandler } from './handler';
import { memoryDeviceStore } from './memoryDeviceStore';
import { memoryGroupStore } from './memoryGroupStore';
import { memoryProfileStore } from './memoryProfileStore';
import type { FnUrlEvent } from './respond';
import type { PuzzleStore } from './store';
import { seedDevice, type TestDevice } from './testDevice';

// CONTRACT (#271): `POST /groups` is the caller's own groups and every membership write —
// create (the creator is a member), join by id, leave, and the creator's remove — each
// answering the list as it now stands; `GET /groups?id=` is a group's public face. Caps
// from `shared/scores.ts`; the name wears the player name's charset and is never empty.

const emptyStore: PuzzleStore = {
  getPuzzle: async () => null,
  getWordPuzzle: async () => null,
  getSlice: async () => null,
};
const NOW = new Date('2026-09-13T12:00:00Z');

async function makeHandler(checkAccounts = true) {
  const devices = memoryDeviceStore();
  const groups = memoryGroupStore(checkAccounts ? (id) => devices.accountExists(id) : undefined);
  const profiles = memoryProfileStore((id) => devices.accountExists(id));
  const handler = createHandler({
    store: emptyStore,
    now: () => NOW,
    groups,
    profiles,
    deviceStore: devices,
    devices: { turnstile: { verify: async () => true }, allowSourceIp: true },
  });
  const me = await seedDevice(devices);
  const them = await seedDevice(devices);
  return { groups, profiles, handler, devices, me, them };
}

function post(body: unknown): FnUrlEvent {
  return { rawPath: '/groups', requestContext: { http: { method: 'POST' } }, body: JSON.stringify(body) };
}
function get(id: string): FnUrlEvent {
  return { rawPath: '/groups', queryStringParameters: { id }, requestContext: { http: { method: 'GET' } } };
}

type Answer = { groups: GroupSummary[]; created?: string };

async function call(handler: ReturnType<typeof createHandler>, body: unknown, status = 200): Promise<Answer> {
  const result = await handler(post(body));
  expect(result.statusCode).toBe(status);
  expect(result.headers['Cache-Control']).toBe('no-store');
  return JSON.parse(result.body) as Answer;
}

async function create(handler: ReturnType<typeof createHandler>, device: TestDevice, name = 'Les_copains') {
  const answer = await call(handler, { token: device.token, create: true, name });
  expect(answer.created).toMatch(/^[a-z2-7]{16}$/);
  return answer.created!;
}

describe('groups route (#271) — create, join, leave, remove', () => {
  it('creates a group with its creator as first member, and lists it', async () => {
    const { handler, me } = await makeHandler();
    const id = await create(handler, me);
    const { groups } = await call(handler, { token: me.token });
    expect(groups).toEqual([
      { id, name: 'Les_copains', createdBy: me.accountId, joinedAt: NOW.toISOString(), members: [me.accountId] },
    ]);
  });

  it('joins by id from ONE tap, and a re-tap is an ordinary answer', async () => {
    const { handler, me, them, groups } = await makeHandler();
    const id = await create(handler, me);
    const first = await call(handler, { token: them.token, join: id });
    expect(first.groups.map((g) => g.id)).toEqual([id]);
    const again = await call(handler, { token: them.token, join: id });
    expect(again.groups.map((g) => g.id)).toEqual([id]);
    // Both joined at the same instant: the order is then by id, deterministically.
    expect((await groups.members(id)).map((m) => m.publicId)).toEqual([me.accountId, them.accountId].sort());
    expect(again.groups[0].members).toEqual([me.accountId, them.accountId].sort());
  });

  it('leaves from either side, idempotently', async () => {
    const { handler, me, them, groups } = await makeHandler();
    const id = await create(handler, me);
    await call(handler, { token: them.token, join: id });
    expect((await call(handler, { token: them.token, leave: id })).groups).toEqual([]);
    expect((await call(handler, { token: them.token, leave: id })).groups).toEqual([]);
    // The creator leaving leaves the group standing for the others.
    await call(handler, { token: them.token, join: id });
    expect((await call(handler, { token: me.token, leave: id })).groups).toEqual([]);
    expect((await groups.members(id)).map((m) => m.publicId)).toEqual([them.accountId]);
  });

  it('lets the CREATOR remove a member, and nobody else', async () => {
    const { handler, me, them, groups } = await makeHandler();
    const id = await create(handler, me);
    await call(handler, { token: them.token, join: id });
    const refused = await handler(post({ token: them.token, remove: id, member: me.accountId }));
    expect(refused.statusCode).toBe(403);
    expect(JSON.parse(refused.body).error).toBe('not_creator');
    // Removing oneself is `leave`, said so.
    expect((await handler(post({ token: me.token, remove: id, member: me.accountId }))).statusCode).toBe(400);
    await call(handler, { token: me.token, remove: id, member: them.accountId });
    expect((await groups.members(id)).map((m) => m.publicId)).toEqual([me.accountId]);
    await expect(groups.listMine(them.accountId)).resolves.toEqual([]);
  });

  it('refuses a malformed body: two verbs, a bad id, a bad name, an unknown group', async () => {
    const { handler, me } = await makeHandler();
    expect((await handler(post({ token: me.token, join: 'x'.repeat(16), leave: 'x'.repeat(16) }))).statusCode).toBe(400);
    expect((await handler(post({ token: me.token, join: 'NOPE' }))).statusCode).toBe(400);
    expect((await handler(post({ token: me.token, create: true, name: '' }))).statusCode).toBe(400);
    expect((await handler(post({ token: me.token, create: true, name: 'Zoé' }))).statusCode).toBe(400);
    expect((await handler(post({ token: me.token, create: true, name: 'W'.repeat(17) }))).statusCode).toBe(400);
    expect((await handler(post({ token: me.token, create: 'yes', name: 'Ok' }))).statusCode).toBe(400);
    const gone = await handler(post({ token: me.token, join: 'abcdefghij234567' }));
    expect(gone.statusCode).toBe(404);
    expect(JSON.parse(gone.body).error).toBe('unknown_group');
    // No token, or a token nobody issued.
    expect((await handler(post({ create: true, name: 'Ok' }))).statusCode).toBe(400);
    const stranger = await handler(post({ token: 'f'.repeat(64) }));
    expect(stranger.statusCode).toBe(401);
    expect(JSON.parse(stranger.body).error).toBe('unknown_device');
  });

  it('moderates the name like a player name', async () => {
    const { handler, me } = await makeHandler();
    const refused = await handler(post({ token: me.token, create: true, name: 'hitler' }));
    expect(refused.statusCode).toBe(400);
    expect(JSON.parse(refused.body).error).toBe('name_rejected');
  });

  it('caps how many groups one player is in (GROUPS_MAX), on create and on join', async () => {
    const { handler, me, them } = await makeHandler();
    const ids: string[] = [];
    for (let i = 0; i < GROUPS_MAX; i += 1) ids.push(await create(handler, me, `G${i}`));
    const more = await handler(post({ token: me.token, create: true, name: 'One_more' }));
    expect(more.statusCode).toBe(409);
    expect(JSON.parse(more.body).error).toBe('group_limit');
    const other = await create(handler, them, 'Theirs');
    const join = await handler(post({ token: me.token, join: other }));
    expect(join.statusCode).toBe(409);
    expect(JSON.parse(join.body).error).toBe('group_limit');
    // A group already held is never refused by the cap.
    expect((await handler(post({ token: me.token, join: ids[0] }))).statusCode).toBe(200);
  });

  it('caps a group at GROUP_MEMBERS_MAX members', async () => {
    // Filler members are not seeded accounts, so this harness skips the account check.
    const { handler, me, them, groups } = await makeHandler(false);
    const id = await create(handler, me);
    for (let i = 1; i < GROUP_MEMBERS_MAX; i += 1) {
      await groups.join({ id, publicId: `member${String(i).padStart(10, '0')}`, now: NOW.toISOString() });
    }
    const full = await handler(post({ token: them.token, join: id }));
    expect(full.statusCode).toBe(409);
    expect(JSON.parse(full.body).error).toBe('group_full');
  });
});

describe('groups route (#271) — the public face', () => {
  it('answers a group by id with its members dressed, dropping a gone account', async () => {
    const { handler, me, them, profiles, devices } = await makeHandler();
    const id = await create(handler, me);
    await call(handler, { token: them.token, join: id });
    await profiles.upsert({ publicId: them.accountId, name: 'Zoe', avatar: 'A'.repeat(19), now: NOW.toISOString() });
    const result = await handler(get(id));
    expect(result.statusCode).toBe(200);
    const face = JSON.parse(result.body);
    expect(face).toMatchObject({ id, name: 'Les_copains', createdBy: me.accountId });
    // Same instant, so ordered by id.
    expect(face.members).toEqual(
      [
        { publicId: me.accountId, name: '', avatar: null },
        { publicId: them.accountId, name: 'Zoe', avatar: 'A'.repeat(19) },
      ].sort((a, b) => (a.publicId < b.publicId ? -1 : 1)),
    );
    // The account behind a member vanishes (#204): the face drops them — the PROFILE
    // lookup is what says gone, so the group store here simply holds the membership.
    const groups = memoryGroupStore();
    await groups.create({ id, name: 'Les_copains', createdBy: me.accountId, now: NOW.toISOString() });
    const gone = createHandler({
      store: emptyStore,
      groups,
      profiles: memoryProfileStore(() => false),
      deviceStore: devices,
      devices: { turnstile: { verify: async () => true }, allowSourceIp: true },
    });
    const answer = await gone(get(id));
    expect(answer.statusCode).toBe(200);
    expect(JSON.parse(answer.body).members).toEqual([]);
  });

  it('is a 404 for an unknown group and a 400 for a malformed id', async () => {
    const { handler } = await makeHandler();
    expect((await handler(get('abcdefghij234567'))).statusCode).toBe(404);
    expect((await handler(get('NOPE'))).statusCode).toBe(400);
  });
});
