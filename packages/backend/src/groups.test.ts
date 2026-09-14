import { describe, expect, it, vi } from 'vitest';
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
    await call(handler, { token: them.token, join: id });
    // The OWNER leaving a group of two hands it to the other member (successionFor).
    expect((await call(handler, { token: me.token, leave: id })).groups).toEqual([]);
    expect((await groups.members(id)).map((m) => m.publicId)).toEqual([them.accountId]);
    expect((await groups.get(id))?.createdBy).toBe(them.accountId);
    expect((await call(handler, { token: them.token })).groups[0]).toMatchObject({ id, createdBy: them.accountId });
  });

  it('DELETES a group its last member leaves', async () => {
    const { handler, me, groups } = await makeHandler();
    const id = await create(handler, me);
    expect((await call(handler, { token: me.token, leave: id })).groups).toEqual([]);
    await expect(groups.get(id)).resolves.toBeNull();
    expect((await handler(get(id))).statusCode).toBe(404);
    // A join after that is an unknown group, not a resurrection.
    expect((await handler(post({ token: me.token, join: id }))).statusCode).toBe(404);
  });

  it('makes the owner of three or more NAME a successor, and takes only a member', async () => {
    const { handler, me, them, devices, groups } = await makeHandler();
    const third = await seedDevice(devices);
    const outsider = await seedDevice(devices);
    const id = await create(handler, me);
    await call(handler, { token: them.token, join: id });
    await call(handler, { token: third.token, join: id });
    const refused = await handler(post({ token: me.token, leave: id }));
    expect(refused.statusCode).toBe(409);
    expect(JSON.parse(refused.body).error).toBe('successor_required');
    // Still there, still the owner.
    expect((await groups.members(id)).map((m) => m.publicId)).toContain(me.accountId);
    // A successor who is not a member is the same refusal; a malformed one is a 400.
    expect((await handler(post({ token: me.token, leave: id, successor: outsider.accountId }))).statusCode).toBe(409);
    expect((await handler(post({ token: me.token, leave: id, successor: 'nope' }))).statusCode).toBe(400);
    // A member leaving names nobody, whatever they send.
    await call(handler, { token: third.token, join: id });
    expect((await call(handler, { token: third.token, leave: id, successor: them.accountId })).groups).toEqual([]);
    expect((await groups.get(id))?.createdBy).toBe(me.accountId);
    await call(handler, { token: third.token, join: id });
    // The named member takes the group over.
    expect((await call(handler, { token: me.token, leave: id, successor: third.accountId })).groups).toEqual([]);
    expect((await groups.get(id))?.createdBy).toBe(third.accountId);
    expect((await groups.members(id)).map((m) => m.publicId).sort()).toEqual([them.accountId, third.accountId].sort());
    // And the new owner can remove; the old one is no longer a member to argue.
    await call(handler, { token: third.token, remove: id, member: them.accountId });
    expect((await groups.members(id)).map((m) => m.publicId)).toEqual([third.accountId]);
  });

  it('drops AND deletes a membership whose group row is gone', async () => {
    const { handler, me, them, groups } = await makeHandler();
    const id = await create(handler, me);
    await call(handler, { token: them.token, join: id });
    // The group row goes under a member (the store's own delete, as the last leave does).
    await groups.leave(id, me.accountId, { expectedVersion: (await groups.get(id))!.membershipVersion, deleteGroup: true });
    expect((await call(handler, { token: them.token })).groups).toEqual([]);
    await expect(groups.listMine(them.accountId)).resolves.toEqual([]);
  });

  it('leaveAll (the departure) hands an owned group to its OLDEST member', async () => {
    const { handler, me, them, devices, groups } = await makeHandler();
    const third = await seedDevice(devices);
    const id = await create(handler, me);
    await call(handler, { token: them.token, join: id });
    await call(handler, { token: third.token, join: id });
    const alone = await create(handler, me, 'Solo');
    await groups.leaveAll(me.accountId);
    // Both joined at the same instant (the test clock stands still), so the OLDEST is the
    // tie rule's: `byJoinedAt` orders equal instants by id.
    expect((await groups.get(id))?.createdBy).toBe([them.accountId, third.accountId].sort()[0]);
    await expect(groups.get(alone)).resolves.toBeNull();
    await expect(groups.listMine(me.accountId)).resolves.toEqual([]);
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
    expect((await handler(post({ token: me.token, create: true, name: 'W'.repeat(21) }))).statusCode).toBe(400);
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

  it('takes a 20-character name and refuses a 21st', async () => {
    const { handler, me } = await makeHandler();
    await create(handler, me, 'Les_copains_du_lundi');
    expect((await handler(post({ token: me.token, create: true, name: 'a'.repeat(21) }))).statusCode).toBe(400);
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


describe('membership changes between a leave decision and its transaction', () => {
  it('re-evaluates the successor when the selected member leaves first', async () => {
    const { handler, me, them, devices, groups } = await makeHandler();
    const third = await seedDevice(devices);
    const id = await create(handler, me);
    await call(handler, { token: them.token, join: id });
    await call(handler, { token: third.token, join: id });
    const leave = groups.leave.bind(groups);
    vi.spyOn(groups, 'leave').mockImplementationOnce(async (...args) => {
      await call(handler, { token: them.token, leave: id });
      return leave(...args);
    });
    await call(handler, { token: me.token, leave: id, successor: them.accountId });
    expect((await groups.get(id))?.createdBy).toBe(third.accountId);
    expect((await groups.members(id)).map((m) => m.publicId)).toEqual([third.accountId]);
  });

  it('asks for a new choice if multiple members remain after the successor leaves', async () => {
    const { handler, me, them, devices, groups } = await makeHandler();
    const third = await seedDevice(devices);
    const fourth = await seedDevice(devices);
    const id = await create(handler, me);
    for (const device of [them, third, fourth]) await call(handler, { token: device.token, join: id });
    const leave = groups.leave.bind(groups);
    vi.spyOn(groups, 'leave').mockImplementationOnce(async (...args) => {
      await call(handler, { token: them.token, leave: id });
      return leave(...args);
    });
    const result = await handler(post({ token: me.token, leave: id, successor: them.accountId }));
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body).error).toBe('successor_required');
    expect((await groups.get(id))?.createdBy).toBe(me.accountId);
    expect((await groups.members(id)).map((m) => m.publicId)).toContain(me.accountId);
  });

  it('preserves a join that commits before the last member leaves', async () => {
    const { handler, me, them, groups } = await makeHandler();
    const id = await create(handler, me);
    const leave = groups.leave.bind(groups);
    vi.spyOn(groups, 'leave').mockImplementationOnce(async (...args) => {
      await call(handler, { token: them.token, join: id });
      return leave(...args);
    });
    await call(handler, { token: me.token, leave: id });
    expect((await groups.get(id))?.createdBy).toBe(them.accountId);
    expect((await groups.members(id)).map((m) => m.publicId)).toEqual([them.accountId]);
    expect((await handler(get(id))).statusCode).toBe(200);
  });

  it('rechecks ownership when a non-owner becomes owner during their leave', async () => {
    const { handler, me, them, devices, groups } = await makeHandler();
    const third = await seedDevice(devices);
    const id = await create(handler, me);
    for (const device of [them, third]) await call(handler, { token: device.token, join: id });
    const leave = groups.leave.bind(groups);
    vi.spyOn(groups, 'leave').mockImplementationOnce(async (...args) => {
      await call(handler, { token: me.token, leave: id, successor: them.accountId });
      return leave(...args);
    });
    await call(handler, { token: them.token, leave: id });
    expect((await groups.get(id))?.createdBy).toBe(third.accountId);
    expect((await groups.members(id)).map((m) => m.publicId)).toEqual([third.accountId]);
  });

  it('refuses an old owner removing a member after handing over ownership', async () => {
    const { handler, me, them, groups } = await makeHandler();
    const id = await create(handler, me);
    await call(handler, { token: them.token, join: id });
    const leave = groups.leave.bind(groups);
    vi.spyOn(groups, 'leave').mockImplementationOnce(async (...args) => {
      await call(handler, { token: me.token, leave: id });
      return leave(...args);
    });
    const result = await handler(post({ token: me.token, remove: id, member: them.accountId }));
    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body).error).toBe('not_creator');
    expect((await groups.members(id)).map((m) => m.publicId)).toEqual([them.accountId]);
  });

  it('re-reads a stale departure job rather than assigning a departed successor', async () => {
    const { handler, me, them, devices, groups } = await makeHandler();
    const third = await seedDevice(devices);
    const id = await create(handler, me);
    await groups.join({ id, publicId: them.accountId, now: '2026-09-13T13:00:00Z' });
    await groups.join({ id, publicId: third.accountId, now: '2026-09-13T14:00:00Z' });
    const leave = groups.leave.bind(groups);
    vi.spyOn(groups, 'leave').mockImplementationOnce(async (...args) => {
      await call(handler, { token: them.token, leave: id });
      return leave(...args);
    });
    await groups.leaveAll(me.accountId);
    expect((await groups.get(id))?.createdBy).toBe(third.accountId);
    expect(await groups.listMine(me.accountId)).toEqual([]);
  });
});
