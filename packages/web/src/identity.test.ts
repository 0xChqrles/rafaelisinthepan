// CONTRACT (#216): this device holds a REVOCABLE token and the SERVER assigns the account.
//
// What is pinned here is what makes the model work rather than the plumbing around it: the
// identity is created LAZILY (a visit that acts creates one; a visit that does not creates
// nothing and asks the server nothing), the token is PERSISTED before the bootstrap so a
// lost answer is retried onto the SAME identity, `unknown_device` and only `unknown_device`
// signs a device out, and every identity change is announced so the state that identity owns
// can be cleared before an old answer repopulates a new one.

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
  deviceIdentity,
  ensureDeviceIdentity,
  identityEpoch,
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
  storage = fakeStorage();
  vi.stubGlobal('window', { localStorage: storage } as unknown as Window & typeof globalThis);
  resetDeviceIdentity();
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
    loadDeviceIdentity();
    expect(deviceIdentity()).toEqual({ token: 'a'.repeat(64), accountId: ACCOUNT, deviceId: DEVICE });
    expect(post).not.toHaveBeenCalled();
  });

  it('treats a token with no ids as NO identity, and retries onto that token', async () => {
    // A bootstrap that never answered. The account it may have created is EMPTY — the act
    // it was minted for waits on the answer — so private reads are still skipped, and the
    // next act retries onto the same token rather than minting a second identity.
    const token = 'b'.repeat(64);
    storage.setItem('whippin-device', JSON.stringify({ token }));
    loadDeviceIdentity();
    expect(deviceIdentity()).toBeNull();
    await ensureDeviceIdentity();
    expect(post.mock.calls[0][1].token).toBe(token);
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
    const denied = {} as Window & typeof globalThis;
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
});

describe('being signed out (#216)', () => {
  it('drops the identity and raises the screen, ONCE', async () => {
    await ensureDeviceIdentity();
    markDeviceSignedOut();
    expect(deviceIdentity()).toBeNull();
    expect(stored()).toBeNull();
    expect(useIdentityStore.getState().signedOut).toBe(true);
  });

  it('SKIP discards the old identity and starts fresh on the next act', async () => {
    const first = await ensureDeviceIdentity();
    markDeviceSignedOut();
    startFreshDevice();
    expect(useIdentityStore.getState().signedOut).toBe(false);
    post.mockResolvedValue(answer('qqqqqqqqqqqqqqqq', 'rrrrrrrrrrrrrrrr'));
    const second = await ensureDeviceIdentity();
    expect(second.token).not.toBe(first.token);
    expect(second.accountId).not.toBe(first.accountId);
  });
});

describe('local state follows the identity that owns it (#216)', () => {
  it('announces an ACCOUNT change and a DEVICE change, and neither for a no-op', async () => {
    const seen: { accountChanged: boolean; deviceChanged: boolean }[] = [];
    const stop = onIdentityChange((change) => seen.push(change));

    await ensureDeviceIdentity();
    expect(seen).toEqual([{ accountChanged: true, deviceChanged: true }]);

    // Re-adopting the SAME identity announces nothing: nothing it owns has moved.
    loadDeviceIdentity();
    expect(seen).toHaveLength(1);

    markDeviceSignedOut();
    expect(seen[1]).toEqual({ accountChanged: true, deviceChanged: true });
    stop();
  });

  it('gives every private request an epoch to be fenced against', async () => {
    const identity = await ensureDeviceIdentity();
    expect(identityEpoch()).toBe(`${identity.accountId}:${identity.deviceId}`);
    markDeviceSignedOut();
    // An answer captured under the old epoch can no longer match, which is what stops the
    // identity just left from repopulating the one that replaced it.
    expect(identityEpoch()).toBeNull();
  });
});
