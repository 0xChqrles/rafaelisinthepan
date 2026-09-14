// CONTRACT (#271): joining a group is a BUTTON, never a page load — the tap deploys the
// clicker's identity if they have none, records the membership, and never dead-ends. A
// SUCCESS is confirmed on screen before continuing. A non-cap 4xx is a verdict the player
// cannot argue with and continues silently; only the backend failing is worth retrying, on
// the error surface. THREE answers are said out loud as blockers — the failure, the caps
// (verdicts the player CAN act on), and an expired link.

import { describe, expect, it, vi } from 'vitest';
import { groupFrom, sendJoin } from './GroupInvite';

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

  it('says so when a cap refused the join, instead of continuing silently', async () => {
    await expect(answer(409, { error: 'group_full' })).resolves.toBe('full');
    await expect(answer(409, { error: 'group_limit' })).resolves.toBe('full');
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
