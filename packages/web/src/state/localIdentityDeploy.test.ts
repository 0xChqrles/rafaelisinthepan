// CONTRACT (user-decided 2026-08-26): the username is decided LOCALLY and DEPLOYED with
// the account. What is pinned here is the rule, not the plumbing: acquiring an identity
// stores the placeholder this device has been showing (the local seed's assigned name and
// mark) as the account's profile — but ONLY into an account that holds nothing (a 404;
// even an empty stored row is somebody's deliberate save), never inside the profile
// editor's own SAVE deploy, and a failure that will not land gives up after bounded
// retries instead of surfacing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anonName, defaultAvatar } from '@whippin/shared';

vi.mock('../turnstile', () => ({ turnstileToken: vi.fn(async () => 'challenge') }));
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  devicesUrl: () => 'https://api.test/devices',
  postDevicesBody: vi.fn(),
  profileUrl: () => 'https://api.test/profile',
  postProfileBody: vi.fn(),
}));

import { postDevicesBody, postProfileBody } from '../api';
import {
  deviceIdentity,
  ensureDeviceIdentity,
  resetDeviceIdentity,
} from '../identity';
import {
  installLocalIdentityDeploy,
  withoutLocalIdentityDeploy,
} from './localIdentityDeploy';
import { useGameStore } from './gameStore';

const bootstrap = vi.mocked(postDevicesBody);
const save = vi.mocked(postProfileBody);

const ACCOUNT = 'abcdefghij234567';
const DEVICE = 'zyxwvutsrq765432';
const SEED = 'lmnopqrst234567';

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

let storage: Storage;

function jsonResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

// The deploy reads the profile first and writes only on a 404. `postProfileBody` is
// mocked separately, so every call reaching `fetch` here is that GET.
let readAnswer: () => Response;
const fetchMock = vi.fn(async (): Promise<Response> => readAnswer());

async function settle(): Promise<void> {
  // The deployment runs detached off the identity change; let its microtasks land.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  storageListeners.length = 0;
  storage = fakeStorage();
  vi.stubGlobal('window', fakeWindow(storage));
  vi.stubGlobal('navigator', { locks: { request: lockRequest } });
  resetDeviceIdentity();
  lockRequest.mockReset();
  lockRequest.mockImplementation(async (_name, task) => task(null));
  bootstrap.mockReset();
  bootstrap.mockResolvedValue(
    {
      ok: true,
      status: 200,
      json: async () => ({ accountId: ACCOUNT, deviceId: DEVICE, devices: [] }),
    } as unknown as Response,
  );
  save.mockReset();
  save.mockResolvedValue(jsonResponse(200));
  fetchMock.mockClear();
  readAnswer = () => jsonResponse(404, { error: 'not_found' });
  useGameStore.setState({ localSeed: SEED });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('deploying the locally-decided username (user-decided 2026-08-26)', () => {
  it('stores exactly the placeholder the device has been showing', async () => {
    const remove = installLocalIdentityDeploy();
    try {
      const identity = await ensureDeviceIdentity();
      await settle();
      expect(save).toHaveBeenCalledOnce();
      expect(save).toHaveBeenCalledWith('https://api.test/profile', {
        token: identity.token,
        name: anonName(SEED),
        avatar: defaultAvatar(SEED),
      });
    } finally {
      remove();
    }
  });

  it('never overwrites a stored profile — even an empty-looking one', async () => {
    readAnswer = () =>
      jsonResponse(200, { publicId: ACCOUNT, name: '', avatar: null });
    const remove = installLocalIdentityDeploy();
    try {
      await ensureDeviceIdentity();
      await settle();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(save).not.toHaveBeenCalled();
    } finally {
      remove();
    }
  });

  it('stands down inside the profile editor\u2019s SAVE deploy', async () => {
    const remove = installLocalIdentityDeploy();
    try {
      await withoutLocalIdentityDeploy(() => ensureDeviceIdentity());
      await settle();
      expect(deviceIdentity()).not.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    } finally {
      remove();
    }
  });

  it('gives up bounded and silent when nothing lands — never throwing into the deploy tap', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new Error('offline'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const remove = installLocalIdentityDeploy();
    try {
      await ensureDeviceIdentity();
      // Initial attempt + DEPLOY_RETRIES backoff waits.
      await vi.advanceTimersByTimeAsync(3_500);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      remove();
    }
  });
});
