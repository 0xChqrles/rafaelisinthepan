// CONTRACT (root AGENTS.md):
//   - The live routes: clients act on the error CODE, never on the status alone — a 5xx, a
//     transport failure or an unparseable body is NEVER a verdict.
//   - Devices, accounts: every private request captures the identity epoch its inputs were
//     built under and stands down if the identity changes; nothing it answered is published.
//   - Groups: every write answers the list as it now stands (published for the account it is
//     about); the invite link is `<site>/g/<groupId>` after one line of copy.
//   - The board and the result's seat share ONE write, ONE reading of its answer and ONE
//     invite message.
//   - On a write whose outcome is unknown the client re-reads before writing again: a create
//     that landed behind a lost answer is found in that read, never sent twice — and a leave
//     or a remove that landed is found there too, so what the error surface says is what the
//     list holds.

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
  reload: vi.fn(),
  held: null as GroupSummary[] | null,
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
vi.mock('./groups', () => ({
  adoptGroups: mocks.adopt,
  loadGroups: mocks.reload,
  useGroupsStore: { getState: () => ({ groups: mocks.held }) },
}));
vi.mock('./signedOutVerdict', () => ({ adoptSignedOutVerdict: vi.fn() }));

import {
  createGroup,
  createRefusalOf,
  createVerdictOf,
  failureOf,
  groupFailureCopy,
  inviteText,
  leaveGroup,
  removeMember,
  writeGroups,
} from './groupActs';

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
  mocks.reload.mockReset();
  mocks.reload.mockResolvedValue(undefined);
  mocks.held = null;
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
    expect(failureOf('create', write)).toBeNull();
    expect(createVerdictOf(write)).toBe('created');
  });

  it('reads a refusal off its code: a banned name, the cap, a stale succession', async () => {
    // A create's own two refusals are the naming screen's to answer, never the error surface's.
    mocks.post.mockResolvedValueOnce(answer(400, { error: 'name_rejected' }));
    const banned = await writeGroups(EPOCH, create);
    expect(banned).toEqual({ kind: 'refused', error: 'name_rejected' });
    expect(createRefusalOf(banned)).toBe('name');
    expect(createVerdictOf(banned)).toBe('name');
    expect(failureOf('create', banned)).toBeNull();

    mocks.post.mockResolvedValueOnce(answer(409, { error: 'group_limit' }));
    const capped = await writeGroups(EPOCH, create);
    expect(capped).toEqual({ kind: 'refused', error: 'group_limit' });
    expect(createRefusalOf(capped)).toBe('limit');
    expect(createVerdictOf(capped)).toBe('limit');
    expect(failureOf('create', capped)).toBeNull();

    // The leave asks again: no failure to say.
    mocks.post.mockResolvedValueOnce(answer(409, { error: 'successor_required' }));
    expect(failureOf('leave', await writeGroups(EPOCH, (token) => ({ token, leave: GROUP })))).toBeNull();

    // Any other code is a refusal the surface names by its act.
    mocks.post.mockResolvedValueOnce(answer(409, { error: 'group_full' }));
    const full = await writeGroups(EPOCH, create);
    expect(failureOf('create', full)).toBe('create');
    expect(createRefusalOf(full)).toBeNull();
    expect(createVerdictOf(full)).toBe('other');
    mocks.post.mockResolvedValueOnce(answer(403, { error: 'not_creator' }));
    expect(failureOf('remove', await writeGroups(EPOCH, (token) => ({ token, remove: GROUP, member: 'm' })))).toBe('remove');
    expect(mocks.adopt).not.toHaveBeenCalled();
  });

  it('never reads a 5xx, an unreadable body or a lost connection as a verdict', async () => {
    mocks.post.mockResolvedValueOnce(answer(500, { error: 'name_rejected' }));
    const crashed = await writeGroups(EPOCH, create);
    expect(crashed).toEqual({ kind: 'failed' });
    expect(failureOf('create', crashed)).toBe('create');
    expect(failureOf('leave', crashed)).toBe('leave');
    // A banned-looking body behind a 5xx is no verdict on the name.
    expect(createRefusalOf(crashed)).toBeNull();

    mocks.post.mockResolvedValueOnce(answer(502, '<html>bad gateway</html>'));
    expect(await writeGroups(EPOCH, create)).toEqual({ kind: 'failed' });

    // A 4xx with no code to read (an edge's own page) says nothing about the request either.
    mocks.post.mockResolvedValueOnce(answer(403, '<html>forbidden</html>'));
    expect(await writeGroups(EPOCH, create)).toEqual({ kind: 'failed' });

    mocks.post.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await writeGroups(EPOCH, create)).toEqual({ kind: 'failed' });
    expect(mocks.adopt).not.toHaveBeenCalled();
    // Each unknown outcome read the list again before saying anything.
    expect(mocks.reload).toHaveBeenCalledTimes(4);
  });

  it('reads nothing again after an answer it can read', async () => {
    mocks.post.mockResolvedValueOnce(answer(400, { error: 'name_rejected' }));
    await writeGroups(EPOCH, create);
    mocks.post.mockResolvedValueOnce(answer(200, { groups: [created], created: GROUP }));
    await writeGroups(EPOCH, create);
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it('says the account failed when the deploy before it did, and sends nothing', async () => {
    mocks.ensure.mockRejectedValue(new Error('bootstrap failed'));
    const write = await writeGroups(EPOCH, create);
    expect(write).toEqual({ kind: 'account' });
    expect(failureOf('create', write)).toBe('account');
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('stands down when the device holds another identity than the screen was drawn for', async () => {
    mocks.epoch = 'bbbbbbbbbbbbbbbb:dddddddddddddddd';
    const write = await writeGroups(EPOCH, create);
    expect(write).toEqual({ kind: 'stale' });
    expect(failureOf('create', write)).toBeNull();
    expect(createVerdictOf(write)).toBe('other');
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

describe('createGroup', () => {
  const other: GroupSummary = { ...created, id: 'abcdefghijklmnop', name: 'OLD' };

  it('finds the group a lost answer created in the list read again, and says it landed', async () => {
    mocks.held = [other];
    mocks.post.mockResolvedValueOnce(answer(502, '<html>bad gateway</html>'));
    mocks.reload.mockImplementationOnce(async () => {
      mocks.held = [other, created];
    });
    const write = await createGroup(EPOCH, 'CREW');
    expect(write).toEqual({ kind: 'done', created: GROUP });
    expect(failureOf('create', write)).toBeNull();
  });

  it('still fails when the list read again holds no new group of that name', async () => {
    mocks.held = [other];
    mocks.post.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await createGroup(EPOCH, 'CREW')).toEqual({ kind: 'failed' });
    // A group of that name held BEFORE the tap is not this tap's.
    mocks.held = [created];
    mocks.post.mockResolvedValueOnce(answer(500, {}));
    expect(await createGroup(EPOCH, 'CREW')).toEqual({ kind: 'failed' });
  });

  it('passes a readable answer through untouched', async () => {
    mocks.post.mockResolvedValueOnce(answer(409, { error: 'group_limit' }));
    expect(await createGroup(EPOCH, 'CREW')).toEqual({ kind: 'refused', error: 'group_limit' });
    expect(mocks.reload).not.toHaveBeenCalled();
  });
});

describe('leaveGroup and removeMember', () => {
  const crew: GroupSummary = { ...created, members: [A.accountId, 'mmmmmmmmmmmmmmmm'] };

  it('find a leave that landed behind a lost answer in the list read again', async () => {
    mocks.held = [crew];
    mocks.post.mockResolvedValueOnce(answer(502, '<html>bad gateway</html>'));
    mocks.reload.mockImplementationOnce(async () => {
      mocks.held = [];
    });
    const write = await leaveGroup(EPOCH, GROUP, (token) => ({ token, leave: GROUP }));
    expect(write).toEqual({ kind: 'done' });
    expect(failureOf('leave', write)).toBeNull();
  });

  it('say the leave failed while the list read again still holds the group', async () => {
    mocks.held = [crew];
    mocks.post.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const write = await leaveGroup(EPOCH, GROUP, (token) => ({ token, leave: GROUP }));
    expect(write).toEqual({ kind: 'failed' });
    expect(failureOf('leave', write)).toBe('leave');
    // A list nobody could read claims nothing landed.
    mocks.held = null;
    mocks.post.mockResolvedValueOnce(answer(500, {}));
    expect(await leaveGroup(EPOCH, GROUP, (token) => ({ token, leave: GROUP }))).toEqual({ kind: 'failed' });
  });

  it('find a remove that landed in the members read again, and send the member named', async () => {
    mocks.held = [crew];
    mocks.post.mockResolvedValueOnce(answer(503, {}));
    mocks.reload.mockImplementationOnce(async () => {
      mocks.held = [{ ...crew, members: [A.accountId] }];
    });
    expect(await removeMember(EPOCH, GROUP, 'mmmmmmmmmmmmmmmm')).toEqual({ kind: 'done' });
    expect(mocks.post).toHaveBeenCalledWith('https://api.test/groups', {
      token: A.token,
      remove: GROUP,
      member: 'mmmmmmmmmmmmmmmm',
    });

    mocks.post.mockResolvedValueOnce(answer(503, {}));
    const still = await removeMember(EPOCH, GROUP, A.accountId);
    expect(still).toEqual({ kind: 'failed' });
    expect(failureOf('remove', still)).toBe('remove');
  });

  it('pass a readable answer through untouched', async () => {
    mocks.post.mockResolvedValueOnce(answer(409, { error: 'successor_required' }));
    expect(await leaveGroup(EPOCH, GROUP, (token) => ({ token, leave: GROUP }))).toEqual({
      kind: 'refused',
      error: 'successor_required',
    });
    expect(mocks.reload).not.toHaveBeenCalled();
  });
});

describe('the error copy', () => {
  it('names each act by what was lost, and the cause by what to do', () => {
    expect(groupFailureCopy('en', 'create')).toEqual({
      title: 'GROUP NOT CREATED',
      note: 'Check your connection and try again.',
    });
    expect(groupFailureCopy('fr', 'create').title).toBe('GROUPE NON CRÉÉ');
    expect(groupFailureCopy('fr', 'leave').title).toBe('TOUJOURS DANS LE GROUPE');
    expect(groupFailureCopy('en', 'remove').title).toBe('MEMBER NOT REMOVED');
    expect(groupFailureCopy('fr', 'share').title).toBe('LIEN NON PARTAGÉ');
  });
});

describe('inviteText', () => {
  it('is the invite line, then the group link', () => {
    expect(inviteText('en', 'https://whippin.ai', GROUP)).toBe(`join my group on Whippin:\nhttps://whippin.ai/g/${GROUP}`);
    expect(inviteText('fr', 'https://whippin.ai', GROUP)).toBe(`rejoins mon groupe sur Whippin :\nhttps://whippin.ai/g/${GROUP}`);
  });
});
