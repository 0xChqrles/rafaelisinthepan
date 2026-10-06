// CONTRACT (root AGENTS.md):
//   - The live routes: clients act on the error CODE, never on the status alone — a 5xx, a
//     transport failure or an unparseable body is NEVER a verdict.
//   - Devices, accounts: every private request captures the identity epoch its inputs were
//     built under and stands down if the identity changes; nothing it answered is published.
//   - Groups: every write answers the list as it now stands (published for the account it is
//     about); the invite link is `<site>/g/<groupId>` after one line of copy.
//   - The board and the result's seat share ONE write, ONE reading of its answer and ONE
//     invite message.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupSummary } from '@whippin/shared';

const A = { token: 'a'.repeat(64), accountId: 'lfd5pqz5pa7zjm5u', deviceId: 'd'.repeat(16) };
const EPOCH = `${A.accountId}:${A.deviceId}`;
const GROUP = 'zwjxqk37xfkvtxqu';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  ensure: vi.fn(),
  epoch: null as string | null,
  adopt: vi.fn(),
}));
vi.mock('../api', () => ({
  groupsUrl: () => 'https://api.test/groups',
  parseGroups: (data: unknown) => data,
  postGroupsBody: mocks.post,
}));
vi.mock('../identity', () => ({
  ensureRequestIdentity: mocks.ensure,
  identityEpoch: () => mocks.epoch,
}));
vi.mock('./groups', () => ({ adoptGroups: mocks.adopt }));
vi.mock('./signedOutVerdict', () => ({ adoptSignedOutVerdict: vi.fn() }));

import { failureOf, groupFailureCopy, inviteText, writeGroups } from './groupActs';

const created: GroupSummary = { id: GROUP, name: 'CREW', createdBy: A.accountId, joinedAt: '2026-10-06T00:00:00.000Z', members: [A.accountId] };
// An answer as `fetch` gives it: its body read once, a copy readable too.
const answer = (status: number, body: unknown) => {
  const json = async () => (typeof body === 'string' ? JSON.parse(body) : body);
  return { ok: status >= 200 && status < 300, status, json, clone: () => ({ json }) };
};
const create = (token: string) => ({ token, create: true as const, name: 'CREW' });

beforeEach(() => {
  mocks.post.mockReset();
  mocks.adopt.mockReset();
  mocks.ensure.mockReset();
  mocks.epoch = EPOCH;
  mocks.ensure.mockImplementation(async (expected: string | null) =>
    expected !== null && expected !== mocks.epoch ? null : { identity: A, epoch: mocks.epoch },
  );
});

describe('writeGroups', () => {
  it('publishes the list it answered, for the account it is about, and names what a create minted', async () => {
    mocks.post.mockResolvedValue(answer(200, { groups: [created], created: GROUP }));
    const write = await writeGroups(EPOCH, create);
    expect(write).toEqual({ kind: 'done', created: GROUP });
    expect(mocks.post).toHaveBeenCalledWith('https://api.test/groups', { token: A.token, create: true, name: 'CREW' });
    expect(mocks.adopt).toHaveBeenCalledWith({ groups: [created], created: GROUP }, A.accountId);
    expect(failureOf(write)).toBeNull();
  });

  it('reads a refusal off its code: a banned name, the cap, a stale succession', async () => {
    mocks.post.mockResolvedValueOnce(answer(400, { error: 'name_rejected' }));
    const banned = await writeGroups(EPOCH, create);
    expect(banned).toEqual({ kind: 'refused', error: 'name_rejected' });
    expect(failureOf(banned)).toBe('name');

    mocks.post.mockResolvedValueOnce(answer(409, { error: 'group_limit' }));
    const capped = await writeGroups(EPOCH, create);
    expect(capped).toEqual({ kind: 'refused', error: 'group_limit' });
    expect(failureOf(capped)).toBe('limit');

    // The leave asks again: no failure to say.
    mocks.post.mockResolvedValueOnce(answer(409, { error: 'successor_required' }));
    expect(failureOf(await writeGroups(EPOCH, (token) => ({ token, leave: GROUP })))).toBeNull();

    // Any other code is a refusal the board names plainly.
    mocks.post.mockResolvedValueOnce(answer(409, { error: 'group_full' }));
    expect(failureOf(await writeGroups(EPOCH, create))).toBe('group');
    expect(mocks.adopt).not.toHaveBeenCalled();
  });

  it('never reads a 5xx, an unreadable body or a lost connection as a verdict', async () => {
    mocks.post.mockResolvedValueOnce(answer(500, { error: 'name_rejected' }));
    const crashed = await writeGroups(EPOCH, create);
    expect(crashed).toEqual({ kind: 'failed' });
    expect(failureOf(crashed)).toBe('group');

    mocks.post.mockResolvedValueOnce(answer(502, '<html>bad gateway</html>'));
    expect(await writeGroups(EPOCH, create)).toEqual({ kind: 'failed' });

    // A 4xx with no code to read (an edge's own page) says nothing about the request either.
    mocks.post.mockResolvedValueOnce(answer(403, '<html>forbidden</html>'));
    expect(await writeGroups(EPOCH, create)).toEqual({ kind: 'failed' });

    mocks.post.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await writeGroups(EPOCH, create)).toEqual({ kind: 'failed' });
    expect(mocks.adopt).not.toHaveBeenCalled();
  });

  it('says the account failed when the deploy before it did, and sends nothing', async () => {
    mocks.ensure.mockRejectedValue(new Error('bootstrap failed'));
    const write = await writeGroups(EPOCH, create);
    expect(write).toEqual({ kind: 'account' });
    expect(failureOf(write)).toBe('account');
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('stands down when the device holds another identity than the screen was drawn for', async () => {
    mocks.epoch = 'bbbbbbbbbbbbbbbb:dddddddddddddddd';
    const write = await writeGroups(EPOCH, create);
    expect(write).toEqual({ kind: 'stale' });
    expect(failureOf(write)).toBeNull();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('publishes nothing when the identity moved while the request was out', async () => {
    mocks.post.mockImplementation(async () => {
      mocks.epoch = 'bbbbbbbbbbbbbbbb:dddddddddddddddd';
      return answer(200, { groups: [created], created: GROUP });
    });
    expect(await writeGroups(EPOCH, create)).toEqual({ kind: 'stale' });
    expect(mocks.adopt).not.toHaveBeenCalled();
  });
});

describe('the error copy', () => {
  it("says a banned group name the way the profile's banned name is said", () => {
    expect(groupFailureCopy('en', 'name')).toEqual({
      title: 'NAME NOT ALLOWED',
      note: 'This name is not allowed. Pick another one and save again.',
    });
    expect(groupFailureCopy('fr', 'limit').title).toBe('TROP DE GROUPES');
    expect(groupFailureCopy('en', 'group').title).toBe('FAILED');
  });
});

describe('inviteText', () => {
  it('is the invite line, then the group link', () => {
    expect(inviteText('en', 'https://whippin.ai', GROUP)).toBe(`join my group on Whippin:\nhttps://whippin.ai/g/${GROUP}`);
    expect(inviteText('fr', 'https://whippin.ai', GROUP)).toBe(`rejoins mon groupe sur Whippin :\nhttps://whippin.ai/g/${GROUP}`);
  });
});
