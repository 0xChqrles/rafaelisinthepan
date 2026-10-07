// CONTRACT (#207): deleting the account from `/account`. The answer is read off its CODE; an
// UNKNOWN outcome (a 5xx, a dropped connection, an unreadable body) is never a verdict — the
// device reads where it stands before saying anything, and a token that authenticates no
// more IS the deletion (the account row is gone, so a replay after a lost answer meets
// `unknown_device`). When that read is lost too nothing is known, and nothing is claimed;
// a later signed-out verdict naming the account is then the deletion arriving late. Once
// gone, the device forgets the account — only while it is still that account's — and goes
// home; never the signed-out screen.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeleteAccountAnswer, DeviceStanding } from '../api';

const A = { token: 'f'.repeat(64), accountId: 'lfd5pqz5pa7zjm5u', deviceId: 'd'.repeat(16) };

const mocks = vi.hoisted(() => ({
  deleteAccount: vi.fn(),
  readDeviceStanding: vi.fn(),
  startFreshDevice: vi.fn(),
  forgetAll: vi.fn(),
  navigate: vi.fn(),
  identity: {
    state: {
      identity: null as { token: string; accountId: string; deviceId: string } | null,
      signedOut: false,
      signedOutAs: null as { accountId: string; deviceId: string } | null,
    },
    listeners: new Set<(state: unknown) => void>(),
  },
}));

type IdentityState = typeof mocks.identity.state;

// A write to the identity store, delivered to its subscribers as zustand does: the verdict
// a private call (or a sibling tab's tombstone) raises.
function identityWrite(next: Partial<IdentityState>): void {
  mocks.identity.state = { ...mocks.identity.state, ...next };
  for (const listener of [...mocks.identity.listeners]) listener(mocks.identity.state);
}

vi.mock('../api', () => ({
  deleteAccount: mocks.deleteAccount,
  readDeviceStanding: mocks.readDeviceStanding,
}));
vi.mock('../identity', () => ({
  currentRequestIdentity: () =>
    mocks.identity.state.identity === null
      ? null
      : { identity: mocks.identity.state.identity, epoch: 'epoch' },
  startFreshDevice: mocks.startFreshDevice,
  useIdentityStore: {
    getState: () => mocks.identity.state,
    subscribe: (listener: (state: unknown) => void) => {
      mocks.identity.listeners.add(listener);
      return () => mocks.identity.listeners.delete(listener);
    },
  },
}));
vi.mock('./gameStore', () => ({
  useGameStore: { getState: () => ({ forgetAll: mocks.forgetAll }) },
}));
vi.mock('../routing', () => ({ navigate: mocks.navigate }));

const { deletionOutcome, deleteThisAccount, forgetDeletedAccount, resetAccountDeletion } = await import(
  './accountDeletion'
);

const outcomeOf = async (answer: DeleteAccountAnswer, standing: DeviceStanding = 'unknown') => {
  const reread = vi.fn(async () => standing);
  const outcome = await deletionOutcome(async () => answer, reread);
  return { outcome, reread };
};

beforeEach(() => {
  for (const fn of [
    mocks.deleteAccount,
    mocks.readDeviceStanding,
    mocks.startFreshDevice,
    mocks.forgetAll,
    mocks.navigate,
  ]) {
    fn.mockReset();
  }
  resetAccountDeletion();
  mocks.identity.state = { identity: { ...A }, signedOut: false, signedOutAs: null };
});

describe('deletionOutcome — what the answers mean', () => {
  it('200 {deleted: true} is DELETED, with no second request', async () => {
    const { outcome, reread } = await outcomeOf('deleted');
    expect(outcome).toBe('deleted');
    expect(reread).not.toHaveBeenCalled();
  });

  it('401 unknown_device is DELETED: a replay after a lost answer authenticates no more', async () => {
    const { outcome, reread } = await outcomeOf('gone');
    expect(outcome).toBe('deleted');
    expect(reread).not.toHaveBeenCalled();
  });

  it('409 account_changed is CHANGED — nothing deleted, nothing re-read', async () => {
    const { outcome, reread } = await outcomeOf('changed');
    expect(outcome).toBe('changed');
    expect(reread).not.toHaveBeenCalled();
  });

  it('another readable 4xx is a verdict: FAILED, never re-read', async () => {
    const { outcome, reread } = await outcomeOf('refused');
    expect(outcome).toBe('failed');
    expect(reread).not.toHaveBeenCalled();
  });

  it('an UNKNOWN outcome re-reads: unknown_device there means the deletion landed', async () => {
    const { outcome, reread } = await outcomeOf('unknown', 'gone');
    expect(reread).toHaveBeenCalledTimes(1);
    expect(outcome).toBe('deleted');
  });

  it('an UNKNOWN outcome re-reads: a list there means the account stands — FAILED', async () => {
    const { outcome, reread } = await outcomeOf('unknown', 'standing');
    expect(reread).toHaveBeenCalledTimes(1);
    expect(outcome).toBe('failed');
  });

  it('an UNKNOWN outcome whose re-read is unknown too claims nothing — UNKNOWN, never FAILED', async () => {
    // "Nothing was deleted" would be a claim the device cannot make: the delete may have
    // landed with its answer lost.
    const { outcome } = await outcomeOf('unknown', 'unknown');
    expect(outcome).toBe('unknown');
  });
});

describe('forgetDeletedAccount — only while the device is still that account', () => {
  it('forgets the identity (START FRESH, no tombstone) and the persisted record', () => {
    expect(forgetDeletedAccount(A)).toBe(true);
    expect(mocks.startFreshDevice).toHaveBeenCalledTimes(1);
    expect(mocks.forgetAll).toHaveBeenCalledTimes(1);
  });

  it('starts fresh FENCING the deleted identity, so a late sibling verdict about it is no screen', () => {
    forgetDeletedAccount(A);
    expect(mocks.startFreshDevice).toHaveBeenCalledWith({ accountId: A.accountId, deviceId: A.deviceId });
  });

  it('lifts the signed-out verdict that names the deleted account (its own echo)', () => {
    mocks.identity.state = {
      identity: null,
      signedOut: true,
      signedOutAs: { accountId: A.accountId, deviceId: A.deviceId },
    };
    expect(forgetDeletedAccount(A)).toBe(true);
    expect(mocks.startFreshDevice).toHaveBeenCalledTimes(1);
    expect(mocks.forgetAll).toHaveBeenCalledTimes(1);
  });

  it('never wipes ANOTHER account a sibling tab installed meanwhile', () => {
    mocks.identity.state = {
      identity: { ...A, accountId: 'zzzzzzzzzzzzzzzz' },
      signedOut: false,
      signedOutAs: null,
    };
    expect(forgetDeletedAccount(A)).toBe(false);
    expect(mocks.startFreshDevice).not.toHaveBeenCalled();
    expect(mocks.forgetAll).not.toHaveBeenCalled();
  });

  it('never lifts a verdict about another account', () => {
    mocks.identity.state = {
      identity: null,
      signedOut: true,
      signedOutAs: { accountId: 'zzzzzzzzzzzzzzzz', deviceId: A.deviceId },
    };
    expect(forgetDeletedAccount(A)).toBe(false);
    expect(mocks.startFreshDevice).not.toHaveBeenCalled();
  });
});

describe('deleteThisAccount — the act', () => {
  it('sends the held token naming the held account, forgets it and goes home on DELETED', async () => {
    mocks.deleteAccount.mockResolvedValue('deleted');
    await expect(deleteThisAccount()).resolves.toBe('deleted');
    expect(mocks.deleteAccount).toHaveBeenCalledWith(expect.objectContaining({ token: A.token, accountId: A.accountId }));
    expect(mocks.startFreshDevice).toHaveBeenCalledTimes(1);
    expect(mocks.forgetAll).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith('/', { replace: true });
  });

  it('re-reads with the SAME token after an unknown outcome', async () => {
    mocks.deleteAccount.mockResolvedValue('unknown');
    mocks.readDeviceStanding.mockResolvedValue('gone');
    await expect(deleteThisAccount()).resolves.toBe('deleted');
    expect(mocks.readDeviceStanding).toHaveBeenCalledWith(A.token);
  });

  it('keeps everything when nothing was deleted', async () => {
    mocks.deleteAccount.mockResolvedValue('unknown');
    mocks.readDeviceStanding.mockResolvedValue('standing');
    await expect(deleteThisAccount()).resolves.toBe('failed');
    expect(mocks.startFreshDevice).not.toHaveBeenCalled();
    expect(mocks.forgetAll).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('an UNKNOWN outcome forgets nothing and goes nowhere — the account may still stand', async () => {
    mocks.deleteAccount.mockResolvedValue('unknown');
    mocks.readDeviceStanding.mockResolvedValue('unknown');
    await expect(deleteThisAccount()).resolves.toBe('unknown');
    expect(mocks.startFreshDevice).not.toHaveBeenCalled();
    expect(mocks.forgetAll).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('after an UNKNOWN outcome, a signed-out verdict naming the account IS the deletion', async () => {
    mocks.deleteAccount.mockResolvedValue('unknown');
    mocks.readDeviceStanding.mockResolvedValue('unknown');
    await deleteThisAccount();
    // A later private call answers `unknown_device`: the verdict names the account asked about.
    identityWrite({ identity: null, signedOut: true, signedOutAs: { accountId: A.accountId, deviceId: A.deviceId } });
    expect(mocks.startFreshDevice).toHaveBeenCalledWith({ accountId: A.accountId, deviceId: A.deviceId });
    expect(mocks.forgetAll).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith('/', { replace: true });
    // Answered once: the watch is spent.
    identityWrite({ signedOut: false, signedOutAs: null });
    identityWrite({ signedOut: true, signedOutAs: { accountId: A.accountId, deviceId: A.deviceId } });
    expect(mocks.forgetAll).toHaveBeenCalledTimes(1);
  });

  it('a verdict already standing when the outcome is unknown answers it at once — DELETED', async () => {
    mocks.deleteAccount.mockResolvedValue('unknown');
    mocks.readDeviceStanding.mockImplementation(async () => {
      // Another private call raised the verdict while this one was being read again.
      identityWrite({ identity: null, signedOut: true, signedOutAs: { accountId: A.accountId, deviceId: A.deviceId } });
      return 'unknown';
    });
    await expect(deleteThisAccount()).resolves.toBe('deleted');
    expect(mocks.forgetAll).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith('/', { replace: true });
  });

  it('after an UNKNOWN outcome, a verdict about ANOTHER account stays a sign-out', async () => {
    mocks.deleteAccount.mockResolvedValue('unknown');
    mocks.readDeviceStanding.mockResolvedValue('unknown');
    await deleteThisAccount();
    identityWrite({
      identity: null,
      signedOut: true,
      signedOutAs: { accountId: 'zzzzzzzzzzzzzzzz', deviceId: A.deviceId },
    });
    expect(mocks.startFreshDevice).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('a deletion KNOWN not to have landed watches for nothing: a later sign-out stays a sign-out', async () => {
    mocks.deleteAccount.mockResolvedValue('unknown');
    mocks.readDeviceStanding.mockResolvedValue('unknown');
    await deleteThisAccount();
    // Pressed again: the account is read standing this time — nothing was deleted.
    mocks.readDeviceStanding.mockResolvedValue('standing');
    await expect(deleteThisAccount()).resolves.toBe('failed');
    identityWrite({ identity: null, signedOut: true, signedOutAs: { accountId: A.accountId, deviceId: A.deviceId } });
    expect(mocks.startFreshDevice).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('a device with no account sends nothing', async () => {
    mocks.identity.state = { identity: null, signedOut: false, signedOutAs: null };
    await expect(deleteThisAccount()).resolves.toBe('failed');
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  });
});
