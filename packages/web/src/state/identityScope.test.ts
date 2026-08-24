// CONTRACT (#216): local state follows the identity that owns it — and ACQUIRING a first
// identity is not the same event as LEAVING one.
//
// A bootstrap is triggered BY an act: the first guess, a word round start. The state on
// screen when it lands is therefore the state that ASKED for it, and clearing there destroys
// exactly that — the guess waiting in the outbox to be sent, and the `wordRounds` entry the
// start's own answer checks itself against. Clearing is for leaving an identity behind.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const resets = vi.hoisted(() => ({ round: vi.fn(), word: vi.fn(), history: vi.fn() }));
const rearms = vi.hoisted(() => ({ round: vi.fn(), word: vi.fn(), history: vi.fn() }));
const kicks = vi.hoisted(() => ({ round: vi.fn() }));

vi.mock('./roundSync', () => ({
  resetRoundSync: resets.round,
  rearmRoundSync: rearms.round,
  kickRoundSync: kicks.round,
}));
vi.mock('./wordRoundSync', () => ({
  resetWordRoundSync: resets.word,
  rearmWordRoundSync: rearms.word,
}));
vi.mock('./history', () => ({
  resetPlayerHistory: resets.history,
  rearmPlayerHistory: rearms.history,
}));

import { useGameStore } from './gameStore';
import { installIdentityScope } from './identityScope';
import { onIdentityChange, type DeviceIdentity } from '../identity';

const A: DeviceIdentity = { token: 'a'.repeat(64), accountId: 'a'.repeat(16), deviceId: 'd'.repeat(16) };
const B: DeviceIdentity = { token: 'b'.repeat(64), accountId: 'b'.repeat(16), deviceId: 'e'.repeat(16) };

// Drive the listener the way `identity.publish` does, without going through storage.
// `adopted` mirrors publish's own derivation: a null -> identity acquisition is an adoption
// unless the tab's own bootstrap minted it, which the caller says explicitly.
function announce(
  previous: DeviceIdentity | null,
  next: DeviceIdentity | null,
  minted = true,
): void {
  const change = {
    previous,
    next,
    accountChanged: (previous?.accountId ?? null) !== (next?.accountId ?? null),
    deviceChanged: (previous?.deviceId ?? null) !== (next?.deviceId ?? null),
    adopted: previous === null && next !== null && !minted,
  };
  // `installIdentityScope` registers the only listener under test; calling it through the
  // real registry is what keeps this a test of the WIRING rather than of a copy of it.
  for (const listener of listeners) listener(change);
}

const listeners: ((change: Parameters<Parameters<typeof onIdentityChange>[0]>[0]) => void)[] = [];
vi.mock('../identity', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    onIdentityChange: (listener: (change: never) => void) => {
      listeners.push(listener as never);
      return () => listeners.splice(listeners.indexOf(listener as never), 1);
    },
  };
});

const seeded = () => ({
  outbox: { 'd:5:fr': { puzzle: 'rev', guesses: ['bois'] } },
  wordRounds: {
    'w:5:fr': { word: 'phare', startedAt: 1, deadline: 2, tried: ['mer'], claimed: 1 },
  },
});

beforeEach(() => {
  listeners.length = 0;
  resets.round.mockReset();
  resets.word.mockReset();
  resets.history.mockReset();
  rearms.round.mockReset();
  rearms.word.mockReset();
  rearms.history.mockReset();
  kicks.round.mockReset();
  useGameStore.setState(
    { ...seeded(), identityOwner: null, roundLoads: {}, activeWordKey: null },
    false,
  );
  installIdentityScope();
});

describe('acquiring a FIRST identity (#216)', () => {
  it('clears NOTHING — the state on screen is what asked for the bootstrap', () => {
    announce(null, A);
    expect(resets.round).not.toHaveBeenCalled();
    expect(resets.word).not.toHaveBeenCalled();
    expect(resets.history).not.toHaveBeenCalled();
    // The guess that triggered the bootstrap is still owed to the account it just got.
    expect(useGameStore.getState().outbox).toEqual(seeded().outbox);
    expect(useGameStore.getState().wordRounds).toEqual(seeded().wordRounds);
    expect(useGameStore.getState().identityOwner).toEqual({
      accountId: A.accountId,
      deviceId: A.deviceId,
    });
  });

  it('a MINTED first identity re-arms nothing — the account is empty by construction', () => {
    announce(null, A);
    expect(rearms.round).not.toHaveBeenCalled();
    expect(rearms.word).not.toHaveBeenCalled();
    expect(rearms.history).not.toHaveBeenCalled();
    // …but it KICKS the round conversations: an outbox that was waiting behind the PLAY
    // gate (the pending-bootstrap recovery) is owed the moment the identity exists, and
    // since the trigger rework the append never mints its own.
    expect(kicks.round).toHaveBeenCalledTimes(1);
  });

  it('an ADOPTED first identity re-reads the tokenless projections without clearing', () => {
    // Another tab bootstrapped and this one adopted its identity from storage. The
    // ready-and-empty round and the empty history this tab published while tokenless may
    // be wrong about the adopted account — another tab's guesses, a live word run — and no
    // scope bump fires on a first acquisition, so nothing else would ever re-read them.
    announce(null, A, false);
    expect(rearms.round).toHaveBeenCalledTimes(1);
    expect(rearms.word).toHaveBeenCalledTimes(1);
    expect(rearms.history).toHaveBeenCalledTimes(1);
    // Still a RE-ARM, never a clear: what this device typed is owed to the adopted account.
    expect(resets.round).not.toHaveBeenCalled();
    expect(resets.word).not.toHaveBeenCalled();
    expect(resets.history).not.toHaveBeenCalled();
    expect(useGameStore.getState().outbox).toEqual(seeded().outbox);
    expect(useGameStore.getState().wordRounds).toEqual(seeded().wordRounds);
  });
});

describe('leaving an identity (#216)', () => {
  beforeEach(() => {
    useGameStore.setState({ identityOwner: { accountId: A.accountId, deviceId: A.deviceId } });
  });

  it('clears the account-owned state AND the device-owned state on a sign-out', () => {
    announce(A, null);
    expect(resets.round).toHaveBeenCalledTimes(1);
    expect(resets.word).toHaveBeenCalledTimes(1);
    expect(resets.history).toHaveBeenCalledTimes(1);
    expect(useGameStore.getState().outbox).toEqual({});
    expect(useGameStore.getState().wordRounds).toEqual({});
    expect(useGameStore.getState().identityOwner).toBeNull();
  });

  it('clears both again when one identity replaces another', () => {
    announce(A, B);
    expect(resets.round).toHaveBeenCalledTimes(1);
    expect(useGameStore.getState().outbox).toEqual({});
    expect(useGameStore.getState().wordRounds).toEqual({});
    expect(useGameStore.getState().identityOwner).toEqual({
      accountId: B.accountId,
      deviceId: B.deviceId,
    });
  });

  it('clears only the DEVICE-owned state when the account is unchanged', () => {
    // The shape #204's email link produces: this device moves to a new device row on the
    // SAME account. A word run belongs to the device that played it — its bonus-adjusted
    // deadline lives nowhere else until submission — while the outbox is the account's.
    announce(A, { ...A, deviceId: 'q'.repeat(16) });
    expect(resets.word).toHaveBeenCalledTimes(1);
    expect(resets.round).not.toHaveBeenCalled();
    expect(useGameStore.getState().wordRounds).toEqual({});
    expect(useGameStore.getState().outbox).toEqual(seeded().outbox);
    expect(useGameStore.getState().identityOwner?.deviceId).toBe('q'.repeat(16));
  });
});
