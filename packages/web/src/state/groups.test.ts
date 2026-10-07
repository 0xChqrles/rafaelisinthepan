import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupSummary } from '@whippin/shared';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  identity: { accountId: 'A', token: 'token', deviceId: 'device' } as { accountId: string; token: string; deviceId: string } | null,
}));
vi.mock('../api', () => ({
  groupsUrl: () => '/groups',
  parseGroups: (data: unknown) => data,
  postGroupsBody: mocks.post,
}));
vi.mock('../identity', () => ({
  deviceIdentity: () => mocks.identity,
  identityEpochOf: (identity: { accountId: string }) => identity.accountId,
  currentRequestIdentity: (epoch: string) => mocks.identity?.accountId === epoch
    ? { identity: mocks.identity, epoch }
    : null,
}));
vi.mock('./signedOutVerdict', () => ({ adoptSignedOutVerdict: vi.fn() }));
import { adoptGroups, holdsSomebody, loadGroups, resetGroups, useGroupsStore } from './groups';

const group = (members: string[]): GroupSummary => ({
  id: 'G', name: 'Group', createdBy: 'A', joinedAt: '', members,
});
const response = (groups: GroupSummary[]) => ({ ok: true, json: async () => ({ groups }) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetGroups();
  mocks.post.mockReset();
  mocks.identity = { accountId: 'A', token: 'token', deviceId: 'device' };
});

describe('group refreshes', () => {
  it('refreshes on a later visit and keeps cached members visible while loading', async () => {
    mocks.post.mockResolvedValueOnce(response([group(['A'])]));
    loadGroups();
    await vi.waitFor(() => expect(useGroupsStore.getState().phase).toBe('ready'));
    const next = deferred<ReturnType<typeof response>>();
    mocks.post.mockReturnValueOnce(next.promise);
    loadGroups();
    loadGroups();
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(useGroupsStore.getState()).toEqual({ phase: 'loading', groups: [group(['A'])] });
    next.resolve(response([group(['A', 'B'])]));
    await vi.waitFor(() => expect(useGroupsStore.getState()).toEqual({ phase: 'ready', groups: [group(['A', 'B'])] }));
  });

  it('keeps the last answer on failure and allows the next visit to retry', async () => {
    adoptGroups({ groups: [group(['A'])] }, 'A');
    mocks.post.mockRejectedValueOnce(new Error('offline'));
    loadGroups();
    await vi.waitFor(() => expect(useGroupsStore.getState().phase).toBe('failed'));
    expect(useGroupsStore.getState().groups).toEqual([group(['A'])]);
    mocks.post.mockResolvedValueOnce(response([group(['A', 'B'])]));
    loadGroups();
    await vi.waitFor(() => expect(useGroupsStore.getState().phase).toBe('ready'));
    expect(useGroupsStore.getState().groups).toEqual([group(['A', 'B'])]);
  });

  it('does not let a read overwrite the newer result of a membership write', async () => {
    const old = deferred<ReturnType<typeof response>>();
    mocks.post.mockReturnValueOnce(old.promise);
    loadGroups();
    adoptGroups({ groups: [group(['A', 'B'])] }, 'A');
    old.resolve(response([group(['A'])]));
    await old.promise;
    await Promise.resolve();
    expect(useGroupsStore.getState()).toEqual({ phase: 'ready', groups: [group(['A', 'B'])] });
  });

  it('ignores an old identity failure without clearing the new identity flight', async () => {
    const old = deferred<ReturnType<typeof response>>();
    const next = deferred<ReturnType<typeof response>>();
    mocks.post.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    loadGroups();
    resetGroups();
    mocks.identity = { accountId: 'B', token: 'new-token', deviceId: 'new-device' };
    loadGroups();
    old.reject(new Error('late offline error'));
    await old.promise.catch(() => undefined);
    expect(useGroupsStore.getState()).toEqual({ phase: 'loading', groups: null });
    loadGroups();
    expect(mocks.post).toHaveBeenCalledTimes(2);
    next.resolve(response([]));
    await vi.waitFor(() => expect(useGroupsStore.getState()).toEqual({ phase: 'ready', groups: [] }));
  });

  it('sends a FRESH read past a flight already out, and answers whether its own read landed', async () => {
    // A read out before a write may describe the list as it stood before it.
    const before = deferred<ReturnType<typeof response>>();
    const after = deferred<ReturnType<typeof response>>();
    mocks.post.mockReturnValueOnce(before.promise).mockReturnValueOnce(after.promise);
    const early = loadGroups();
    const fresh = loadGroups({ fresh: true });
    expect(mocks.post).toHaveBeenCalledTimes(2);
    after.resolve(response([group(['A', 'B'])]));
    expect(await fresh).toBe(true);
    // The read it overtook publishes nothing, and says so.
    before.resolve(response([group(['A'])]));
    expect(await early).toBe(false);
    expect(useGroupsStore.getState()).toEqual({ phase: 'ready', groups: [group(['A', 'B'])] });
    // A read that fails answers false.
    mocks.post.mockRejectedValueOnce(new Error('offline'));
    expect(await loadGroups({ fresh: true })).toBe(false);
    expect(useGroupsStore.getState().phase).toBe('failed');
  });

  it('does not make a private request without an identity', () => {
    mocks.identity = null;
    loadGroups();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(useGroupsStore.getState()).toEqual({ phase: 'ready', groups: [] });
  });
});

// CONTRACT (root AGENTS.md): "is there anybody in my groups but me" has ONE reading — the race
// line runs only when there is, the result's SEAT stands only when there is not — and a list
// not known yet names nobody.
describe('holdsSomebody', () => {
  it('holds nobody in a list not known yet, in no group, or in groups of one', () => {
    expect(holdsSomebody(null)).toBe(false);
    expect(holdsSomebody([])).toBe(false);
    expect(holdsSomebody([group(['A']), { ...group(['A']), id: 'H' }])).toBe(false);
  });

  it('holds somebody as soon as one group has a member besides the player', () => {
    expect(holdsSomebody([group(['A']), { ...group(['A', 'B']), id: 'H' }])).toBe(true);
  });
});
