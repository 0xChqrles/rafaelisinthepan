// @vitest-environment jsdom
// CONTRACT (#271, web AGENTS.md "Group invite link"): a member already skips the landing onto
// the group's board — but never one THIS landing is making. A tap that MINTS the identity
// reloads the groups list, and that list can name the new membership before the join's own
// answer is read: the landing stays, and the joined state (the call turned to the BOARD in
// place, said to a screen reader) is what the answer lands on. The call is one button in one
// slot, so the keyboard's focus stays on it from JOIN to the BOARD.

import { act, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupSummary } from '@whippin/shared';

const GROUP = 'zwjxqk37xfkvtxqu';
const OTHER = 'p000000000000001';
const ME = 'lfd5pqz5pa7zjm5u';
const IDENTITY = { token: 'f'.repeat(64), accountId: ME, deviceId: 'd'.repeat(16) };

const world = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    groups: [] as GroupSummary[],
    listeners,
    set(groups: GroupSummary[]) {
      this.groups = groups;
      for (const listener of listeners) listener();
    },
  };
});
const navigate = vi.hoisted(() => vi.fn());
// The reader's own face's read, as `useOwnFace` answers it, and its retry.
const own = vi.hoisted(() => ({ state: null as null | 'failed' }));
const retryOwnFace = vi.hoisted(() => vi.fn());
const postGroupsBody = vi.hoisted(() => vi.fn());

vi.mock('../api', () => ({
  groupsUrl: () => 'https://api.test/groups',
  parseGroups: (data: { groups: unknown }) => data.groups,
  postGroupsBody,
  readGroup: async () => ({
    status: 'shown',
    group: { id: GROUP, name: 'Duo', createdBy: OTHER, members: [{ publicId: OTHER, name: 'Ana', avatar: null }] },
  }),
}));
vi.mock('../state/groups', () => ({
  adoptGroups: (groups: GroupSummary[]) => world.set(groups),
  loadGroups: () => {},
  useGroups: () => {
    const groups = useSyncExternalStore(
      (listener) => {
        world.listeners.add(listener);
        return () => world.listeners.delete(listener);
      },
      () => world.groups,
    );
    return { phase: 'ready', groups };
  },
}));
vi.mock('../identity', () => ({
  deviceIdentity: () => null,
  useDeviceIdentity: () => null,
  // The tap MINTS: the new account's list is read again, and it already names the group the
  // join is committing, while the join's own answer is still on the wire.
  ensureRequestIdentity: async () => {
    world.set([{ id: GROUP, name: 'Duo', createdBy: OTHER, joinedAt: '', members: [OTHER, ME] } as never]);
    return { identity: IDENTITY, epoch: `${ME}:${IDENTITY.deviceId}` };
  },
  identityEpoch: () => `${ME}:${IDENTITY.deviceId}`,
}));
vi.mock('../state/gameStore', () => ({
  useGameStore: (select: (state: { setLastGroup: () => void }) => unknown) => select({ setLastGroup: () => {} }),
}));
vi.mock('../state/signedOutVerdict', () => ({ adoptSignedOutVerdict: async () => {} }));
vi.mock('../turnstile', () => ({ prefetchTurnstileTokens: () => {} }));
vi.mock('../routing', () => ({ navigate }));
vi.mock('../components/AccountFace', () => ({ useOwnFace: () => own.state, shownFace: () => null }));
vi.mock('../state/ownFace', () => ({ retryOwnFace }));
vi.mock('../components/ErrorScreen', () => ({ default: () => null }));
vi.mock('../components/GroupOrbit', async (original) => ({
  ...(await original<typeof import('../components/GroupOrbit')>()),
  default: () => null,
}));

const { default: GroupInvite } = await import('./GroupInvite');

describe('the landing a join is making', () => {
  let root: ReturnType<typeof createRoot>;
  let host: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    world.groups = [];
    own.state = null;
    navigate.mockClear();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('is not skipped when the reloaded list names the group before the answer, and lands joined with the focus kept', async () => {
    let answer!: (response: unknown) => void;
    postGroupsBody.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    await act(async () => root.render(<GroupInvite groupId={GROUP} lang="en" />));

    const call = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('JOIN'))!;
    expect(call).toBeDefined();
    call.focus();
    await act(async () => call.click());

    // The mint's list names the group; the join's answer is still out. The landing stays.
    expect(world.groups.map((group) => group.id)).toEqual([GROUP]);
    expect(navigate).not.toHaveBeenCalled();

    await act(async () =>
      answer({
        ok: true,
        status: 200,
        json: async () => ({ groups: world.groups }),
        clone() {
          return this;
        },
      }),
    );

    expect(navigate).not.toHaveBeenCalled();
    // ONE button in the call's slot: the word changed, the element and the focus did not.
    expect(call.isConnected).toBe(true);
    expect(call.textContent).toContain('LEADERBOARD');
    expect(document.activeElement).toBe(call);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('You joined the group.');
  });

  // The seat waits for the reader's own mark; a read of it that FAILED is no reason to wait
  // forever, nor to ask again in a loop: once as the join lands, then when the tab comes back.
  it('asks the reader’s lost face again ONCE as the join lands, then when the tab comes back', async () => {
    const SECOND = 'abcdefghijklmnop';
    own.state = 'failed';
    retryOwnFace.mockClear();
    postGroupsBody.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ groups: world.groups }),
      clone() {
        return this;
      },
    });
    await act(async () => root.render(<GroupInvite groupId={SECOND} lang="en" />));
    // Not joined yet: the seat promises nothing, and nothing is asked.
    expect(retryOwnFace).not.toHaveBeenCalled();

    const call = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('JOIN'))!;
    await act(async () => call.click());
    expect(retryOwnFace).toHaveBeenCalledTimes(1);
    // The read lost again asks nothing more by itself…
    await act(async () => root.render(<GroupInvite groupId={SECOND} lang="en" />));
    expect(retryOwnFace).toHaveBeenCalledTimes(1);
    // …until the tab comes back.
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(retryOwnFace).toHaveBeenCalledTimes(2);
  });
});
