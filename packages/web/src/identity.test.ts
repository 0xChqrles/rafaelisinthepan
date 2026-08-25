// CONTRACT (#216): this device holds a REVOCABLE token and the SERVER assigns the account.
//
// What is pinned here is what makes the model work rather than the plumbing around it: the
// identity is created LAZILY (a visit that acts creates one; a visit that does not creates
// nothing and asks the server nothing), the token is PERSISTED before the bootstrap so a
// lost answer is retried onto the SAME identity, only authoritative answers (`unknown_device`
// or a confirmed self-revocation) sign a device out, and every identity change is announced
// so the state that identity owns can be cleared before an old answer repopulates a new one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidDeviceToken, PUBLIC_ID_PATTERN } from '@whippin/shared';

vi.mock('./turnstile', () => ({ turnstileToken: vi.fn(async () => 'challenge') }));
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  devicesUrl: () => 'https://api.test/devices',
  postDevicesBody: vi.fn(),
}));

import { postDevicesBody } from './api';
import {
  DEVICE_BOOTSTRAP_LOCK,
  deviceIdentity,
  ensureDeviceIdentity,
  ensureRequestIdentity,
  identityEpoch,
  identityEpochOf,
  identityScopeRevision,
  loadDeviceIdentity,
  markDeviceSignedOut,
  onIdentityChange,
  resetDeviceIdentity,
  startFreshDevice,
  useIdentityStore,
} from './identity';

const post = vi.mocked(postDevicesBody);

const ACCOUNT = 'abcdefghij234567';
const DEVICE = 'zyxwvutsrq765432';

type LockTask = (lock: Lock | null) => unknown;
const lockRequest = vi.fn(async (_name: string, task: LockTask) => task(null));

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: () => null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

let storage: Storage;

// A window stub that is actually a window: this module listens for `storage` events, since
// localStorage is shared by every TAB of the origin. The listeners are CAPTURED so a test
// can deliver another tab's write through the REAL channel (the P1 finding: poking
// `syncFromStorage` alone never proves the listener is wired).
const storageListeners: Array<(event: StorageEvent) => void> = [];
function fakeWindow(store: Storage): Window & typeof globalThis {
  return {
    localStorage: store,
    addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
      if (type === 'storage') storageListeners.push(listener);
    },
    removeEventListener: (type: string, listener: (event: StorageEvent) => void) => {
      const index = storageListeners.indexOf(listener);
      if (index >= 0) storageListeners.splice(index, 1);
    },
  } as unknown as Window & typeof globalThis;
}

// Another tab wrote the shared key: the browser delivers a storage event to every OTHER
// tab — the one signal that crosses them.
function otherTabWrote(): void {
  for (const listener of [...storageListeners]) {
    listener({ key: 'whippin-device' } as StorageEvent);
  }
}

function answer(accountId = ACCOUNT, deviceId = DEVICE): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ accountId, deviceId, devices: [] }),
  } as unknown as Response;
}

function stored(): Record<string, unknown> | null {
  const raw = storage.getItem('whippin-device');
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

beforeEach(() => {
  storageListeners.length = 0;
  storage = fakeStorage();
  vi.stubGlobal('window', fakeWindow(storage));
  vi.stubGlobal('navigator', { locks: { request: lockRequest } });
  resetDeviceIdentity();
  lockRequest.mockReset();
  lockRequest.mockImplementation(async (_name: string, task: LockTask) => task(null));
  post.mockReset();
  post.mockResolvedValue(answer());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the lazy bootstrap (#216)', () => {
  it('creates NOTHING until a deliberate act asks for an identity', () => {
    // Creating on load would make account creation an unauthenticated write that every
    // crawler triggers — and a private read with no identity would ask the server about
    // nobody. `deviceIdentity()` returning null is exactly that signal.
    expect(deviceIdentity()).toBeNull();
    expect(identityEpoch()).toBeNull();
    expect(stored()).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('mints a token, spends ONE challenge, and adopts the ids the SERVER assigned', async () => {
    const identity = await ensureDeviceIdentity();
    expect(isValidDeviceToken(identity.token)).toBe(true);
    expect(identity.accountId).toBe(ACCOUNT);
    expect(identity.accountId).toMatch(PUBLIC_ID_PATTERN);
    expect(identity.deviceId).toBe(DEVICE);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1]).toEqual({
      token: identity.token,
      turnstileToken: 'challenge',
    });
    expect(stored()).toEqual(identity);
  });

  it('PERSISTS the token before the request, so a lost answer retries the SAME identity', async () => {
    let tokenAtRequest: string | undefined;
    post.mockImplementationOnce(async (_url, body) => {
      // What the storage holds WHILE the bootstrap is in flight is what a killed tab would
      // come back to. Without it a retry mints a second token, and the account created
      // behind the lost answer is orphaned for good.
      tokenAtRequest = (stored() as { token?: string } | null)?.token;
      expect(tokenAtRequest).toBe(body.token);
      throw new Error('answer lost');
    });
    await expect(ensureDeviceIdentity()).rejects.toThrow();
    expect(deviceIdentity()).toBeNull();

    // The retry sends the token that was persisted, which is what makes the server's
    // idempotence reachable.
    const identity = await ensureDeviceIdentity();
    expect(identity.token).toBe(tokenAtRequest);
    expect(post.mock.calls[1][1].token).toBe(tokenAtRequest);
  });

  it('runs ONE bootstrap for concurrent triggers', async () => {
    // A first guess while the leaderboard is mounting: two acts in one tick, and each
    // minting its own token would create two accounts for one player.
    const [a, b] = await Promise.all([ensureDeviceIdentity(), ensureDeviceIdentity()]);
    expect(a).toEqual(b);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('serializes the EMPTY read and re-reads storage after entering the origin lock', async () => {
    // Simulate this tab waiting behind another tab that already owns the Web Lock. Both
    // tabs saw EMPTY before either entered; while this one waits, the winner commits its
    // complete identity. The protected re-read must adopt it without minting/posting.
    let enter: (() => void) | null = null;
    lockRequest.mockImplementationOnce(
      (_name: string, task: LockTask) =>
        new Promise((resolve, reject) => {
          enter = () => {
            Promise.resolve(task(null)).then(resolve, reject);
          };
        }),
    );
    const waiting = ensureDeviceIdentity();
    expect(lockRequest).toHaveBeenCalledWith(DEVICE_BOOTSTRAP_LOCK, expect.any(Function));

    const theirs = { token: '9'.repeat(64), accountId: ACCOUNT, deviceId: DEVICE };
    storage.setItem('whippin-device', JSON.stringify(theirs));
    expect(enter).not.toBeNull();
    enter!();

    await expect(waiting).resolves.toEqual(theirs);
    expect(post).not.toHaveBeenCalled();
  });

  it('fails closed when a browser cannot serialize bootstrap across tabs', async () => {
    vi.stubGlobal('navigator', {});
    await expect(ensureDeviceIdentity()).rejects.toThrow(/Web Locks/);
    expect(post).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
  });

  it('refuses a malformed answer rather than keying every row by garbage', async () => {
    post.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ accountId: 'NOT-AN-ID', deviceId: DEVICE, devices: [] }),
    } as unknown as Response);
    await expect(ensureDeviceIdentity()).rejects.toThrow(/accountId/);
    expect(deviceIdentity()).toBeNull();
  });
});

describe('what a reload finds (#216)', () => {
  it('adopts a complete stored identity without asking the server', () => {
    storage.setItem(
      'whippin-device',
      JSON.stringify({ token: 'a'.repeat(64), accountId: ACCOUNT, deviceId: DEVICE }),
    );
    expect(loadDeviceIdentity()).toEqual({
      identity: { token: 'a'.repeat(64), accountId: ACCOUNT, deviceId: DEVICE },
      pending: false,
      readable: true,
    });
    expect(deviceIdentity()).toEqual({ token: 'a'.repeat(64), accountId: ACCOUNT, deviceId: DEVICE });
    expect(post).not.toHaveBeenCalled();
  });

  it('treats a token with no ids as NO identity, and retries onto that token', async () => {
    // A bootstrap that never answered. The account it may have created is EMPTY — the act
    // it was minted for waits on the answer — so private reads are still skipped, and the
    // next act retries onto the same token rather than minting a second identity.
    const token = 'b'.repeat(64);
    storage.setItem('whippin-device', JSON.stringify({ token }));
    expect(loadDeviceIdentity()).toEqual({ identity: null, pending: true, readable: true });
    expect(deviceIdentity()).toBeNull();
    await ensureDeviceIdentity();
    expect(post.mock.calls[0][1].token).toBe(token);
  });

  it('reports an UNREADABLE storage as unknown, never as emptiness', () => {
    // Blocked site data / a private mode whose `localStorage` PROPERTY throws. The null
    // identity is then UNPROVEN — `readable: false` is what tells startup not to treat it
    // as a fresh device and clear identity-owned state (the outbox, the Word rounds) out
    // of an intact game database.
    const denied = fakeWindow(storage);
    Object.defineProperty(denied, 'localStorage', {
      get() {
        throw new Error('SecurityError');
      },
    });
    vi.stubGlobal('window', denied);
    resetDeviceIdentity();
    expect(loadDeviceIdentity()).toEqual({ identity: null, pending: false, readable: false });
  });

  it('replaces a corrupted stored value rather than sending garbage forever', async () => {
    storage.setItem('whippin-device', 'not json');
    loadDeviceIdentity();
    expect(deviceIdentity()).toBeNull();
    const identity = await ensureDeviceIdentity();
    expect(isValidDeviceToken(identity.token)).toBe(true);
  });

  it('degrades to a session identity when the localStorage PROPERTY itself throws', async () => {
    // Browsers with storage disabled throw from the `window.localStorage` GETTER, before
    // any of this module's own bodies run.
    const denied = { addEventListener: () => {}, removeEventListener: () => {} } as unknown as
      Window & typeof globalThis;
    Object.defineProperty(denied, 'localStorage', {
      get() {
        throw new Error('SecurityError: The operation is insecure.');
      },
    });
    vi.stubGlobal('window', denied);
    resetDeviceIdentity();
    const identity = await ensureDeviceIdentity();
    expect(identity.accountId).toBe(ACCOUNT);
    // Same identity for the rest of the session; it simply does not survive a reload.
    await expect(ensureDeviceIdentity()).resolves.toEqual(identity);
  });

  it('keeps the session identity when storage reads work but writes throw', async () => {
    // Quota exhaustion and some private modes expose localStorage normally but reject every
    // write. Reading EMPTY back cannot disprove the identity whose own write just failed.
    const setItem = vi.fn(() => {
      throw new Error('QuotaExceededError');
    });
    storage.setItem = setItem;
    vi.stubGlobal('window', fakeWindow(storage));
    resetDeviceIdentity();

    const identity = await ensureDeviceIdentity();
    expect(stored()).toBeNull();
    await expect(ensureDeviceIdentity()).resolves.toEqual(identity);
    expect(deviceIdentity()).toEqual(identity);
    expect(post).toHaveBeenCalledTimes(1);
    expect(lockRequest).toHaveBeenCalledTimes(1);
    expect(setItem).toHaveBeenCalledTimes(2);
  });

  it('keeps the session identity when only the completed write exceeds storage', async () => {
    // The pending-token JSON is smaller than the completed identity. If only the latter
    // exceeds quota, the readable value is not EMPTY but still belongs to this bootstrap.
    const persist = storage.setItem.bind(storage);
    const setItem = vi.fn((key: string, value: string) => {
      if (setItem.mock.calls.length === 1) persist(key, value);
      else throw new Error('QuotaExceededError');
    });
    storage.setItem = setItem;
    vi.stubGlobal('window', fakeWindow(storage));
    resetDeviceIdentity();

    const identity = await ensureDeviceIdentity();
    expect(stored()).toEqual({ token: identity.token });
    await expect(ensureDeviceIdentity()).resolves.toEqual(identity);
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('being signed out (#216)', () => {
  it('drops the identity, raises the screen ONCE, and leaves the TOMBSTONE', async () => {
    const identity = await ensureDeviceIdentity();
    markDeviceSignedOut(identityEpochOf(identity));
    expect(deviceIdentity()).toBeNull();
    // The stored identity is REPLACED with the non-authenticating verdict, never merely
    // removed (user-decided 2026-08-24): removal read as ordinary identity loss.
    expect(stored()).toEqual({
      signedOut: true,
      accountId: identity.accountId,
      deviceId: identity.deviceId,
    });
    expect(useIdentityStore.getState().signedOut).toBe(true);
  });

  it('fails the mint CLOSED when the verdict lands while the bootstrap is IN FLIGHT', async () => {
    // The pre-flight check cannot see a verdict that arrives during the network legs —
    // the sign-out paths null `flight` but cannot cancel a running one — so the bootstrap
    // re-checks after them: committing the mint would overwrite the tombstone and clear
    // the screen the verdict raised.
    post.mockImplementationOnce(async () => {
      useIdentityStore.setState({ ...useIdentityStore.getState(), signedOut: true });
      return answer();
    });
    await expect(ensureDeviceIdentity()).rejects.toThrow(/signed out/);
    expect(deviceIdentity()).toBeNull();
    expect(useIdentityStore.getState().signedOut).toBe(true);
  });

  it('keeps the verdict across a RELOAD', async () => {
    const identity = await ensureDeviceIdentity();
    markDeviceSignedOut(identityEpochOf(identity));
    // A new session: module state resets, the shared key stands — exactly a reload.
    resetDeviceIdentity();
    const loaded = loadDeviceIdentity();
    expect(loaded.identity).toBeNull();
    expect(loaded.pending).toBe(false);
    expect(useIdentityStore.getState().signedOut).toBe(true);
    // And the standing verdict FAILS THE MINT CLOSED: no ordinary act may create a
    // replacement account — leaving the old one behind is START FRESH's choice alone.
    await expect(ensureDeviceIdentity()).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(1); // only the original bootstrap
  });

  it('reaches a SIBLING TAB as the signed-out screen, never as ordinary identity loss', async () => {
    // This tab holds the identity; another tab replaces the shared entry with the
    // tombstone. Delivered through the REAL storage-event listener `loadDeviceIdentity`
    // installed — not by poking the sync directly — so the test proves the wiring (the P1
    // finding). A bare removal used to read as identity loss, and this tab's next act then
    // minted a fresh account.
    loadDeviceIdentity(); // installs this tab's storage listener
    const identity = await ensureDeviceIdentity();
    storage.setItem(
      'whippin-device',
      JSON.stringify({
        signedOut: true,
        accountId: identity.accountId,
        deviceId: identity.deviceId,
      }),
    );
    otherTabWrote();
    expect(deviceIdentity()).toBeNull();
    expect(useIdentityStore.getState().signedOut).toBe(true);
    await expect(ensureDeviceIdentity()).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(1);

    // And a plain REMOVAL (another tab starting fresh) through the same channel stays
    // ordinary identity loss — no screen.
    resetDeviceIdentity();
    vi.stubGlobal('window', fakeWindow(storage));
    storage.clear();
    loadDeviceIdentity();
    post.mockResolvedValue(answer());
    await ensureDeviceIdentity();
    storage.removeItem('whippin-device');
    otherTabWrote();
    expect(deviceIdentity()).toBeNull();
    expect(useIdentityStore.getState().signedOut).toBe(false);
  });

  it("follows another tab's START FRESH off the signed-out screen", async () => {
    // This tab adopted the tombstone through the storage channel and shows the screen.
    // Another tab taps START FRESH, removing the tombstone origin-wide: the shared verdict
    // is LIFTED, and this tab follows it back to plain emptiness instead of parking on
    // SIGNED OUT until some tab completes a whole new bootstrap.
    loadDeviceIdentity(); // installs this tab's storage listener
    const identity = await ensureDeviceIdentity();
    storage.setItem(
      'whippin-device',
      JSON.stringify({
        signedOut: true,
        accountId: identity.accountId,
        deviceId: identity.deviceId,
      }),
    );
    otherTabWrote();
    expect(useIdentityStore.getState().signedOut).toBe(true);

    storage.removeItem('whippin-device');
    otherTabWrote();
    expect(useIdentityStore.getState().signedOut).toBe(false);
    expect(deviceIdentity()).toBeNull();
  });

  it('an empty key does NOT lift a verdict that never reached storage', async () => {
    // The tombstone write failed (unwritable storage), so the verdict lives only in this
    // tab's memory: the shared key being empty proves nothing about it, and the mint stays
    // closed for the session — only this tab's own START FRESH lifts it.
    loadDeviceIdentity();
    const identity = await ensureDeviceIdentity();
    storage.setItem = vi.fn(() => {
      throw new Error('QuotaExceededError');
    });
    markDeviceSignedOut(identityEpochOf(identity));
    expect(useIdentityStore.getState().signedOut).toBe(true);

    storage.removeItem('whippin-device');
    otherTabWrote();
    expect(useIdentityStore.getState().signedOut).toBe(true);
    await expect(ensureDeviceIdentity()).rejects.toThrow(/signed out/);
  });

  it('a tombstone naming ANOTHER identity does not sign this one out', async () => {
    const identity = await ensureDeviceIdentity();
    storage.setItem(
      'whippin-device',
      JSON.stringify({
        signedOut: true,
        accountId: 'qqqqqqqqqqqqqqqq',
        deviceId: 'rrrrrrrrrrrrrrrr',
      }),
    );
    loadDeviceIdentity();
    // The tombstone names the identity it fences by PUBLIC ids; this is not it.
    expect(deviceIdentity()).toEqual(identity);
    expect(useIdentityStore.getState().signedOut).toBe(false);
  });

  it('SKIP discards the old identity, lifts the tombstone, and starts fresh on the next act', async () => {
    const first = await ensureDeviceIdentity();
    markDeviceSignedOut(identityEpochOf(first));
    expect(stored()).toMatchObject({ signedOut: true });
    startFreshDevice();
    expect(useIdentityStore.getState().signedOut).toBe(false);
    // The tombstone leaves storage with the choice: the whole origin may mint again.
    expect(stored()).toBeNull();
    post.mockResolvedValue(answer('qqqqqqqqqqqqqqqq', 'rrrrrrrrrrrrrrrr'));
    const second = await ensureDeviceIdentity();
    expect(second.token).not.toBe(first.token);
    expect(second.accountId).not.toBe(first.accountId);
  });

  it('does not resurrect a revoked token when conditional storage removal throws', async () => {
    const first = await ensureDeviceIdentity();
    storage.removeItem = vi.fn(() => {
      throw new Error('SecurityError: removal denied');
    });

    markDeviceSignedOut(identityEpochOf(first));
    startFreshDevice();
    post.mockResolvedValue(answer('qqqqqqqqqqqqqqqq', 'rrrrrrrrrrrrrrrr'));
    const replacement = await ensureDeviceIdentity();

    expect(replacement.token).not.toBe(first.token);
    expect(replacement.accountId).toBe('qqqqqqqqqqqqqqqq');
    expect(deviceIdentity()).toEqual(replacement);
  });
});

describe('local state follows the identity that owns it (#216)', () => {
  it('announces an ACCOUNT change and a DEVICE change, and neither for a no-op', async () => {
    const seen: { previous: unknown; next: unknown }[] = [];
    const stop = onIdentityChange((change) => seen.push(change));

    const identity = await ensureDeviceIdentity();
    // The FIRST bootstrap announces `previous: null`, and that distinction is load-bearing:
    // a bootstrap is triggered BY an act, so a listener that cleared here would destroy the
    // guess or the run that asked for it (`state/identityScope.ts`).
    expect(seen).toHaveLength(1);
    expect(identityScopeRevision()).toBe(0);
    expect(seen[0]).toMatchObject({
      previous: null,
      next: identity,
      accountChanged: true,
      deviceChanged: true,
      // MINTED by this tab's own bootstrap: the account is empty by construction, so the
      // scope listener must not re-read the tokenless projections for it.
      adopted: false,
    });

    // Re-adopting the SAME identity announces nothing: nothing it owns has moved.
    loadDeviceIdentity();
    expect(seen).toHaveLength(1);

    markDeviceSignedOut(identityEpochOf(identity));
    expect(seen[1]).toMatchObject({ previous: identity, next: null, accountChanged: true });
    expect(identityScopeRevision()).toBe(1);
    stop();
  });

  it('gives every private request an epoch to be fenced against', async () => {
    const identity = await ensureDeviceIdentity();
    expect(identityEpoch()).toBe(`${identity.accountId}:${identity.deviceId}`);
    markDeviceSignedOut(identityEpochOf(identity));
    // An answer captured under the old epoch can no longer match, which is what stops the
    // identity just left from repopulating the one that replaced it.
    expect(identityEpoch()).toBeNull();
  });
});

describe('localStorage is shared by every TAB (#216)', () => {
  it('refuses to authenticate A-owned inputs when ensure adopts B', async () => {
    const old = await ensureDeviceIdentity();
    const expectedEpoch = identityEpochOf(old);
    const replacement = {
      token: '8'.repeat(64),
      accountId: 'qqqqqqqqqqqqqqqq',
      deviceId: 'rrrrrrrrrrrrrrrr',
    };
    storage.setItem('whippin-device', JSON.stringify(replacement));

    await expect(ensureRequestIdentity(expectedEpoch)).resolves.toBeNull();
    expect(deviceIdentity()).toEqual(replacement);
    // Only A's original bootstrap was posted. The request boundary does not return B to
    // the closure that captured A's inputs.
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('adopts an identity another tab bootstrapped instead of minting a second one', async () => {
    // This tab was opened BEFORE the other one bootstrapped, so its in-memory copy says
    // "no identity". Minting here would overwrite the shared entry and orphan the account
    // the other tab is playing on.
    const theirs = { token: 'c'.repeat(64), accountId: ACCOUNT, deviceId: DEVICE };
    storage.setItem('whippin-device', JSON.stringify(theirs));
    const seen: { adopted: boolean }[] = [];
    const stop = onIdentityChange((change) => seen.push(change));
    await expect(ensureDeviceIdentity()).resolves.toEqual(theirs);
    expect(post).not.toHaveBeenCalled();
    expect(stored()).toEqual(theirs);
    // An ADOPTED first identity: the other tab may already be playing on this account, so
    // the scope listener re-reads the projections this tab published as known-empty.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ previous: null, next: theirs, adopted: true });
    stop();
  });

  it('retries a PENDING token another tab left instead of replacing it', async () => {
    // The other tab persisted its token and was interrupted before committing the ids.
    // Adopting it is what makes the server's idempotence reachable: the retry hashes to the
    // same device item and recovers that account.
    const theirToken = 'd'.repeat(64);
    storage.setItem('whippin-device', JSON.stringify({ token: theirToken }));
    await ensureDeviceIdentity();
    expect(post.mock.calls[0][1].token).toBe(theirToken);
  });

  it('publishes a STORAGE-RECOVERED pending bootstrap as an ADOPTION, never a fresh mint', async () => {
    // A bare {token} in storage does NOT prove an empty account (PR-219 round-2 review):
    // the original session's bootstrap may have ANSWERED and its acts run — a profile
    // saved, a friend added, a word round started — with only the completed identity's
    // write failing behind it. Recovering the token through the server's idempotence
    // returns that very account, so the acquisition must announce `adopted` and let the
    // scope owner re-read the tokenless projections, or the real state stays hidden
    // behind ready-and-empty answers — and could be overwritten.
    const priorToken = 'd'.repeat(64);
    storage.setItem('whippin-device', JSON.stringify({ token: priorToken }));
    loadDeviceIdentity();
    const seen: { adopted: boolean }[] = [];
    const stop = onIdentityChange((change) => seen.push(change));
    await ensureDeviceIdentity();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ adopted: true });
    stop();
  });

  it('a FAILED attempt kills the emptiness proof — the retry publishes as ADOPTED', async () => {
    // Conservative on purpose (PR-219 round-3 review): the failed flight released its Web
    // Lock with the token already persisted, so another tab or session could recover the
    // SAME token, complete the bootstrap and ACT on the account before this retry. The
    // retry therefore announces an adoption — the scope owner re-reads the tokenless
    // projections, which for a truly empty account merely re-reads empty answers.
    post.mockRejectedValueOnce(new Error('offline'));
    await expect(ensureDeviceIdentity()).rejects.toThrow();
    const seen: { adopted: boolean }[] = [];
    const stop = onIdentityChange((change) => seen.push(change));
    post.mockResolvedValue(answer());
    await ensureDeviceIdentity();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ adopted: true });
    // And it really was the SAME token both times (the idempotence key).
    expect(post.mock.calls[1][1].token).toBe(post.mock.calls[0][1].token);
    stop();
  });

  it('yields to a tab that won the race to a DIFFERENT token', async () => {
    const theirs = { token: 'e'.repeat(64), accountId: 'qqqqqqqqqqqqqqqq', deviceId: DEVICE };
    post.mockImplementationOnce(async () => {
      // The other tab finished while this request was in the air. Overwriting its entry
      // would leave two accounts on one device, and orphan the one being played.
      storage.setItem('whippin-device', JSON.stringify(theirs));
      return answer();
    });
    const seen: { adopted: boolean }[] = [];
    const stop = onIdentityChange((change) => seen.push(change));
    await expect(ensureDeviceIdentity()).resolves.toEqual(theirs);
    expect(stored()).toEqual(theirs);
    // The raced adoption is an ADOPTION too — the winning tab may already be playing on
    // that account — so it does not announce as minted-empty.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ next: theirs, adopted: true });
    stop();
  });

  it('does NOT delete a newer tab\'s identity when this one signs out', async () => {
    const identity = await ensureDeviceIdentity();
    const theirs = { token: 'f'.repeat(64), accountId: 'rrrrrrrrrrrrrrrr', deviceId: DEVICE };
    storage.setItem('whippin-device', JSON.stringify(theirs));
    markDeviceSignedOut(identityEpochOf(identity));
    // This tab shows its screen; the entry it did not write stands.
    expect(useIdentityStore.getState().signedOut).toBe(true);
    expect(stored()).toEqual(theirs);

    // SKIP runs after the old identity has already been dropped. With no expected token it
    // must not turn that conditional removal into an unconditional one a beat later.
    startFreshDevice();
    expect(stored()).toEqual(theirs);
    await expect(ensureDeviceIdentity()).resolves.toEqual(theirs);
    // A -> null remounted away from the old account, and null -> B remounts the replacement's
    // private reads. The only acquisition that preserves a mount is the first-ever bootstrap.
    expect(identityScopeRevision()).toBe(2);
  });

  it('ignores a stale signed-out verdict instead of deleting the NEW identity', async () => {
    const old = await ensureDeviceIdentity();
    const oldEpoch = identityEpochOf(old);
    const current = {
      token: '7'.repeat(64),
      accountId: 'ssssssssssssssss',
      deviceId: 'tttttttttttttttt',
    };
    storage.setItem('whippin-device', JSON.stringify(current));
    loadDeviceIdentity();

    expect(identityScopeRevision()).toBe(1);
    expect(markDeviceSignedOut(oldEpoch)).toBe(false);
    expect(deviceIdentity()).toEqual(current);
    expect(stored()).toEqual(current);
    expect(useIdentityStore.getState().signedOut).toBe(false);
  });

  it('keeps the session identity when storage cannot be READ at all', async () => {
    // Unreadable storage says NOTHING about this device's identity — collapsing it into
    // "there is none" would drop an identity this session is already playing on.
    const identity = await ensureDeviceIdentity();
    const denied = { addEventListener: () => {}, removeEventListener: () => {} } as unknown as
      Window & typeof globalThis;
    Object.defineProperty(denied, 'localStorage', {
      get() {
        throw new Error('SecurityError: The operation is insecure.');
      },
    });
    vi.stubGlobal('window', denied);
    await expect(ensureDeviceIdentity()).resolves.toEqual(identity);
    expect(deviceIdentity()).toEqual(identity);
  });

  it('never removes storage blindly when it cannot verify the token still belongs to this tab', async () => {
    const identity = await ensureDeviceIdentity();
    const read = vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: read denied');
    });
    const remove = vi.spyOn(storage, 'removeItem');

    markDeviceSignedOut(identityEpochOf(identity));
    expect(remove).not.toHaveBeenCalled();

    read.mockRestore();
    expect(stored()).toEqual(identity);
  });
});
