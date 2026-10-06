// CONTRACT (#271): joining a group is a BUTTON, never a page load — the tap deploys the
// clicker's identity if they have none, records the membership, and never dead-ends. A
// SUCCESS is confirmed on screen before continuing. A non-cap 4xx is a verdict the player
// cannot argue with and continues silently; only the backend failing is worth retrying, on
// the error surface. THREE answers are said out loud as blockers — the failure, the caps
// (verdicts the player CAN act on), and an expired link.

import { describe, expect, it, vi } from 'vitest';
import { GROUPS_MAX, GROUP_MARKS_SHOWN, GROUP_MEMBERS_MAX } from '@whippin/shared';
import { groupFrom, landingOf, sendJoin } from './GroupInvite';
import { orbitPlacesFor } from '../components/GroupOrbit';

const postGroupsBody = vi.hoisted(() => vi.fn());
const adoptGroups = vi.hoisted(() => vi.fn());
vi.mock('../api', () => ({
  postGroupsBody,
  groupsUrl: () => 'https://api.test/groups',
  parseGroups: (data: unknown) => data,
  readGroup: vi.fn(),
}));
vi.mock('../state/groups', () => ({
  adoptGroups,
  loadGroups: vi.fn(),
  useGroups: () => ({ phase: 'ready', groups: [] }),
}));
vi.mock('../state/gameStore', () => ({ useGameStore: () => vi.fn() }));
vi.mock('../identity', () => ({
  deviceIdentity: () => ({ token: 'f'.repeat(64), accountId: 'lfd5pqz5pa7zjm5u', deviceId: 'd'.repeat(16) }),
  useDeviceIdentity: () => null,
  ensureRequestIdentity: async () => ({
    identity: { token: 'f'.repeat(64), accountId: 'lfd5pqz5pa7zjm5u', deviceId: 'd'.repeat(16) },
    epoch: `lfd5pqz5pa7zjm5u:${'d'.repeat(16)}`,
  }),
  identityEpoch: () => `lfd5pqz5pa7zjm5u:${'d'.repeat(16)}`,
  identityEpochOf: (value: { accountId: string; deviceId: string }) => `${value.accountId}:${value.deviceId}`,
  identityScopeRevision: () => 0,
  markDeviceSignedOut: vi.fn(),
}));

const GROUP = 'zwjxqk37xfkvtxqu';

describe('sendJoin — the tap carries the CLICKER key and the GROUP id', () => {
  const answer = async (status: number, body: unknown = { groups: [] }) => {
    postGroupsBody.mockResolvedValueOnce({
      ok: status < 400,
      status,
      json: async () => body,
      clone() {
        return this;
      },
    });
    return sendJoin(GROUP);
  };

  it('records the membership with this device token, publishes the answered list, and is confirmable', async () => {
    const groups = [{ id: GROUP, name: 'G', createdBy: 'x', joinedAt: '', members: [] }];
    await expect(answer(200, { groups })).resolves.toBe('joined');
    expect(postGroupsBody).toHaveBeenCalledWith('https://api.test/groups', {
      token: 'f'.repeat(64),
      join: GROUP,
    });
    expect(adoptGroups).toHaveBeenCalledWith({ groups }, 'lfd5pqz5pa7zjm5u');
  });

  it('treats an ordinary refusal as settled — nothing to retry, nothing to announce', async () => {
    await expect(answer(400, { error: 'bad_request' })).resolves.toBe('settled');
  });

  it('says WHICH cap refused the join, read off the code, instead of continuing silently', async () => {
    await expect(answer(409, { error: 'group_full' })).resolves.toBe('full');
    await expect(answer(409, { error: 'group_limit' })).resolves.toBe('limit');
  });

  it('a 409 naming no cap is an ordinary refusal — never "this group is full"', async () => {
    await expect(answer(409, { error: 'something_else' })).resolves.toBe('settled');
    await expect(answer(409, {})).resolves.toBe('settled');
    // A body that cannot be read names no code either.
    postGroupsBody.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => {
        throw new Error('unreadable');
      },
      clone() {
        return this;
      },
    });
    await expect(sendJoin(GROUP)).resolves.toBe('settled');
  });

  it('an unknown group is an EXPIRED link, read off the code', async () => {
    await expect(answer(404, { error: 'unknown_group' })).resolves.toBe('expired');
  });

  it('treats the backend failing as retryable', async () => {
    await expect(answer(500)).resolves.toBe('failed');
    await expect(answer(503)).resolves.toBe('failed');
  });
});

describe('groupFrom — what each read means on the landing', () => {
  it('keeps failed reads retryable and expires only a confirmed missing group', () => {
    const group = { id: GROUP, name: 'G', createdBy: 'x', members: [] };
    expect(groupFrom({ status: 'shown', group })).toBe(group);
    expect(groupFrom({ status: 'gone' })).toBe('gone');
    expect(groupFrom({ status: 'failed' })).toBe('failed');
  });
});

const players = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ publicId: `p${String(i).padStart(15, '0')}`, name: '', avatar: null }));
const summaries = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `g${i}`, name: 'G', createdBy: 'x', joinedAt: '', members: [] }));

// A cap the landing already KNOWS is never offered as a JOIN the server can only refuse: the
// group's room off its public face (which never counts more members than the server does), the
// reader's own `GROUPS_MAX` off their list once it has been read.
describe('landingOf — what the landing offers', () => {
  const group = (members: number) => ({ id: GROUP, name: 'G', createdBy: 'x', members: players(members) });

  it('offers JOIN below both caps, and when the reader’s list is unknown', () => {
    expect(landingOf(group(GROUP_MEMBERS_MAX - 1), summaries(GROUPS_MAX - 1))).toBe('open');
    expect(landingOf(group(3), null)).toBe('open');
  });

  it('lands on FULL at the members cap, whatever the reader holds', () => {
    expect(landingOf(group(GROUP_MEMBERS_MAX), [])).toBe('full');
    expect(landingOf(group(GROUP_MEMBERS_MAX), summaries(GROUPS_MAX))).toBe('full');
  });

  it('lands on LIMIT when the reader is already in GROUPS_MAX groups', () => {
    expect(landingOf(group(3), summaries(GROUPS_MAX))).toBe('limit');
  });
});

// The card's own fold (`GROUP_MARKS_SHOWN` places, a `+N` tile in the last of them) with the
// reader's SEAT kept as the last place on the orbit — so it is decided once and never moves.
describe('orbitPlacesFor — who stands on the orbit', () => {
  it('stands every member and keeps the seat last while they fit', () => {
    const places = orbitPlacesFor(players(GROUP_MARKS_SHOWN - 1), true);
    expect(places.map((place) => place.kind)).toEqual([...Array(GROUP_MARKS_SHOWN - 1).fill('member'), 'seat']);
  });

  it('folds the rest into +N before the seat, never past the card’s places', () => {
    const places = orbitPlacesFor(players(49), true);
    expect(places).toHaveLength(GROUP_MARKS_SHOWN);
    expect(places.at(-1)).toEqual({ kind: 'seat' });
    const shown = places.filter((place) => place.kind === 'member').length;
    expect(places.at(-2)).toEqual({ kind: 'more', count: 49 - shown });
  });

  it('is the card’s own fold with no seat to keep', () => {
    const places = orbitPlacesFor(players(GROUP_MEMBERS_MAX), false);
    expect(places).toHaveLength(GROUP_MARKS_SHOWN);
    expect(places.at(-1)).toEqual({ kind: 'more', count: GROUP_MEMBERS_MAX - (GROUP_MARKS_SHOWN - 1) });
  });
});
