// @vitest-environment jsdom
// CONTRACT (root AGENTS.md):
//   - Groups, THE SUCCESSION RULE: a member who is not the owner hands nothing over; a
//     member whose leaving empties the group deletes it; an OWNER leaving a group of TWO
//     hands it to the other member; an OWNER leaving a group of THREE OR MORE must NAME a
//     member as `successor`. The web mirrors the rule off the list on screen and puts the
//     successor on the wire only when the owner had to pick one.
//   - Devices, accounts: every private request captures the (accountId, deviceId) epoch its
//     inputs were built under and stands down if the identity changes — a group write
//     built from account A's screen is never sent as account B.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupSummary } from '@whippin/shared';

const ME = 'lfd5pqz5pa7zjm5u';
const GROUP = 'zwjxqk37xfkvtxqu';

interface TestIdentity {
  token: string;
  accountId: string;
  deviceId: string;
}
const epochOf = vi.hoisted(
  () => (identity: { accountId: string; deviceId: string }) => `${identity.accountId}:${identity.deviceId}`,
);

// `rendered` is the identity this tab last RENDERED with; `held` is what the device holds
// by the time a tap resolves it — another tab can move it in between.
const world = vi.hoisted(() => ({
  rendered: null as TestIdentity | null,
  held: null as TestIdentity | null,
  groups: [] as GroupSummary[],
  open: (_index: number) => {},
  leave: () => {},
  confirm: () => {},
}));
const postGroupsBody = vi.hoisted(() => vi.fn());
const ensureRequestIdentity = vi.hoisted(() => vi.fn());

vi.mock('../api', () => ({
  boardUrl: () => 'https://api.test/board',
  groupsUrl: () => 'https://api.test/groups',
  parseBoard: (data: unknown) => data,
  parseGroups: (data: unknown) => data,
  parsePeriodBoard: (data: unknown) => data,
  // The board read stays in flight: these tests are about the write.
  postBoardBody: () => new Promise(() => {}),
  postGroupsBody,
  readGroup: vi.fn(),
}));
vi.mock('../identity', () => ({
  useDeviceIdentity: () => world.rendered,
  ensureRequestIdentity,
  identityEpoch: () => (world.held ? epochOf(world.held) : null),
  identityEpochOf: epochOf,
}));
vi.mock('../state/groups', () => ({
  adoptGroups: vi.fn(),
  loadGroups: vi.fn(),
  useGroups: () => ({ phase: 'ready', groups: world.groups }),
}));
vi.mock('../state/gameStore', () => {
  const state = { boardTab: 'group', setBoardTab: () => {}, lastGroupId: null, setLastGroup: () => {} };
  return { useGameStore: (select: (s: typeof state) => unknown) => select(state) };
});
vi.mock('../state/signedOutVerdict', () => ({ adoptSignedOutVerdict: vi.fn() }));
vi.mock('../turnstile', () => ({ prefetchTurnstileTokens: vi.fn() }));
vi.mock('../hooks/useShare', () => ({ default: () => ({ share: vi.fn(), copied: false }) }));
vi.mock('../hooks/useToday', () => ({ default: () => 20700 }));
vi.mock('../components/TopBar', () => ({ HeaderLeft: () => null }));
vi.mock('../components/PuzzleTitle', () => ({ default: () => null }));
vi.mock('../components/BoardTabs', () => ({
  default: (p: { onOpen: (index: number) => void }) => {
    world.open = p.onOpen;
    return null;
  },
}));
vi.mock('../components/PeriodSwitch', () => ({ default: () => null }));
vi.mock('../components/GroupScreen', () => ({
  default: (p: { onLeave: () => void }) => {
    world.leave = p.onLeave;
    return null;
  },
}));
vi.mock('../components/ConfirmScreen', () => ({
  default: (p: { onConfirm: () => void }) => {
    world.confirm = p.onConfirm;
    return null;
  },
}));
vi.mock('../components/GroupCreate', () => ({ default: () => null }));
vi.mock('../components/ErrorScreen', () => ({ default: () => null }));
vi.mock('../components/LoadError', () => ({ default: () => null }));
vi.mock('../components/LoadingWave', () => ({ default: () => null }));
vi.mock('../components/Avatar', () => ({ default: () => null }));

import Leaderboard, { leaveBody, leaveKindOf } from './Leaderboard';

const group = (createdBy: string, members: string[]): GroupSummary => ({
  id: GROUP,
  name: 'G',
  createdBy,
  joinedAt: '2026-09-01T00:00:00.000Z',
  members,
});

describe('leaveKindOf — the succession a leave carries, off the list on screen', () => {
  it('a member who is not the owner hands nothing over, whatever the group holds', () => {
    expect(leaveKindOf(group('owner', ['owner', ME]), ME)).toBe('plain');
    expect(leaveKindOf(group('owner', ['owner', ME, 'a', 'b']), ME)).toBe('plain');
  });

  it('an owner alone is the LAST member: the leave deletes the group', () => {
    expect(leaveKindOf(group(ME, [ME]), ME)).toBe('last');
  });

  it('an owner of TWO hands the group to the other member', () => {
    expect(leaveKindOf(group(ME, [ME, 'a']), ME)).toBe('handover');
  });

  it('an owner of THREE OR MORE must pick a successor', () => {
    expect(leaveKindOf(group(ME, [ME, 'a', 'b']), ME)).toBe('pick');
    expect(leaveKindOf(group(ME, ['a', 'b', 'c', ME]), ME)).toBe('pick');
  });

  it('no group, or no account, is never an owner', () => {
    expect(leaveKindOf(null, ME)).toBe('plain');
    expect(leaveKindOf(group(ME, [ME, 'a', 'b']), null)).toBe('plain');
  });
});

describe('leaveBody — the successor is on the wire only when the owner picked one', () => {
  it('names the picked member as `successor` for an owner of three or more', () => {
    expect(leaveBody('t', GROUP, 'pick', 'a')).toEqual({ token: 't', leave: GROUP, successor: 'a' });
  });

  it('every other leave is the group alone, a stale pick included', () => {
    expect(leaveBody('t', GROUP, 'plain', null)).toEqual({ token: 't', leave: GROUP });
    expect(leaveBody('t', GROUP, 'last', null)).toEqual({ token: 't', leave: GROUP });
    expect(leaveBody('t', GROUP, 'handover', 'a')).toEqual({ token: 't', leave: GROUP });
  });
});

describe('a group write travels as the account its screen was drawn for', () => {
  const A: TestIdentity = { token: 'a'.repeat(64), accountId: ME, deviceId: 'd'.repeat(16) };
  const B: TestIdentity = { token: 'a'.repeat(64), accountId: 'bbbbbbbbbbbbbbbb', deviceId: 'd'.repeat(16) };
  let root: ReturnType<typeof createRoot>;

  beforeEach(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    world.rendered = A;
    world.held = A;
    world.groups = [group('owner', ['owner', ME])];
    postGroupsBody.mockReset();
    postGroupsBody.mockResolvedValue({ ok: true, status: 200, json: async () => ({ groups: [] }) });
    // The fence `identity.ts` states: the identity the device holds now, refused when the
    // request's inputs were captured under another one.
    ensureRequestIdentity.mockReset();
    ensureRequestIdentity.mockImplementation(async (expected: string | null) => {
      const epoch = epochOf(world.held!);
      return expected !== null && expected !== epoch ? null : { identity: world.held!, epoch };
    });
    root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Leaderboard lang="en" />));
    // Into the group's own screen, then LEAVE: the confirmation is up.
    await act(async () => world.open(0));
    await act(async () => world.leave());
  });
  afterEach(async () => {
    await act(async () => root.unmount());
  });

  it('sends the leave with the token of the identity that drew the screen', async () => {
    await act(async () => world.confirm());
    expect(ensureRequestIdentity).toHaveBeenCalledWith(epochOf(A));
    expect(postGroupsBody).toHaveBeenCalledWith('https://api.test/groups', { token: A.token, leave: GROUP });
  });

  it('stands down when another tab moved the device onto another account before the tap', async () => {
    // An email-link adopt in a sibling tab keeps the token and changes the account; this
    // tab has not re-rendered yet.
    world.held = B;
    await act(async () => world.confirm());
    expect(postGroupsBody).not.toHaveBeenCalled();
  });
});
