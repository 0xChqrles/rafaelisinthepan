// @vitest-environment jsdom
// CONTRACT: the player's OWN face (`useOwnFace`, what the header's face key draws) follows the
// profile this device writes. `GET /profile` stays its only source; the writers only signal.
//   - a MINTED account's first profile is the seed's face, so from the tokenless face through
//     the deploy to the read-back profile, the face drawn never changes — no face derived
//     from the new account id in between, no skeleton;
//   - a deploy refused with 409 (another writer's row won) draws that stored row, never
//     the seed's face the deploy tried to store;
//   - a SAVE re-reads the face, the previous one standing while the read is out;
//   - a FAILED read changes nothing already drawn, and a minted account whose read-back
//     fails keeps the seed's face;
//   - a FIRST read that fails, with no face drawn, settles `'failed'` — never the account
//     id's assigned stranger — and asking again (`retryOwnFace`) waits, then lands the face;
//   - an account that is GONE (410) settles on no face: nothing masks it.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anonName, defaultAvatar } from '@whippin/shared';

vi.mock('../turnstile', () => ({ turnstileToken: vi.fn(async () => 'challenge') }));
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  devicesUrl: () => 'https://api.test/devices',
  postDevicesBody: vi.fn(),
  postProfileBody: vi.fn(),
}));

import { postDevicesBody, postProfileBody } from '../api';
import { ensureDeviceIdentity, loadDeviceIdentity, resetDeviceIdentity } from '../identity';
import { installLocalIdentityDeploy } from '../state/localIdentityDeploy';
import { ownProfileWritten, retryOwnFace } from '../state/ownFace';
import { useGameStore } from '../state/gameStore';
import { useOwnFace, type FaceState } from './AccountFace';

const ACCOUNT = 'abcdefghij234567';
const DEVICE = 'zyxwvutsrq765432';
const SEED = 'lmnopqrst234567a';
const TOKEN = 'a'.repeat(64);
const OTHER_AVATAR = defaultAvatar('qqqqqqqqqqqqqqqq');

// The server: stored profile rows, deleted accounts, and every profile request in order.
let rows: Map<string, { name: string; avatar: string | null }>;
let gone: Set<string>;
// Every profile read answers 503 while set: a read that FAILED, not evidence of anything.
let unavailable: boolean;
let log: string[];
// The deploy's create is HELD until the test lets it land, so the header's own read — if it
// goes out during the deploy — meets the account before its first profile exists.
let releaseCreate: () => void;

function json(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, clone() { return this; } } as unknown as Response;
}

const fetchMock = vi.fn(async (url: string): Promise<Response> => {
  const id = new URL(url).searchParams.get('id') ?? '';
  log.push(`GET ${id}`);
  if (unavailable) return json(503, { error: 'unavailable' });
  if (gone.has(id)) return json(410, { error: 'account_gone' });
  const row = rows.get(id);
  return row ? json(200, { publicId: id, ...row }) : json(404, { error: 'not_found' });
});

// What the face DRAWS: the name, and the mark (a missing avatar draws the id's assigned one).
function drawn(state: FaceState): string | null {
  if (state === null || state === 'gone' || state === 'failed') return state;
  return `${state.name}|${state.avatar ?? defaultAvatar(state.publicId)}`;
}
const SEED_FACE = `${anonName(SEED)}|${defaultAvatar(SEED)}`;
const ACCOUNT_FACE = `${anonName(ACCOUNT)}|${defaultAvatar(ACCOUNT)}`;

let seen: FaceState[];
function Probe() {
  seen.push(useOwnFace());
  return null;
}

let container: HTMLDivElement;
let root: Root;
let removeDeploy: () => void;

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubEnv('VITE_API_BASE_URL', 'https://api.test');
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(window.navigator, 'locks', {
    configurable: true,
    value: { request: async (_name: string, task: (lock: null) => unknown) => task(null) },
  });
  window.localStorage.clear();
  resetDeviceIdentity();
  rows = new Map();
  gone = new Set();
  unavailable = false;
  log = [];
  seen = [];
  vi.mocked(postDevicesBody).mockReset();
  vi.mocked(postDevicesBody).mockResolvedValue(
    json(200, { accountId: ACCOUNT, deviceId: DEVICE, devices: [] }),
  );
  vi.mocked(postProfileBody).mockReset();
  vi.mocked(postProfileBody).mockImplementation(async (_url, body) => {
    log.push('POST');
    await new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    if (body.createOnly && rows.has(ACCOUNT)) return json(409, { error: 'profile_exists' });
    rows.set(ACCOUNT, { name: body.name, avatar: body.avatar });
    return json(200, { publicId: ACCOUNT, name: body.name, avatar: body.avatar });
  });
  useGameStore.setState({ localSeed: SEED });
  removeDeploy = installLocalIdentityDeploy();
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
  removeDeploy();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// Every face drawn once the first one settled.
function drawnSinceSettled(): (string | null)[] {
  const faces = seen.map(drawn);
  return faces.slice(faces.findIndex((face) => face !== null));
}

describe('the own face across a MINT and its deploy', () => {
  it('draws the seed face throughout — never the account id’s, never a skeleton', async () => {
    expect(drawn(seen[seen.length - 1])).toBe(SEED_FACE);
    await act(async () => {
      await ensureDeviceIdentity();
    });
    await flush();
    expect(log).toEqual([`GET ${ACCOUNT}`, 'POST']);
    await act(async () => releaseCreate());
    await flush();
    const last = seen[seen.length - 1];
    expect(last !== null && last !== 'gone' && last !== 'failed' && last.publicId).toBe(ACCOUNT);
    // The face is READ BACK once the profile exists, and only then.
    expect(log).toEqual([`GET ${ACCOUNT}`, 'POST', `GET ${ACCOUNT}`]);
    expect(new Set(drawnSinceSettled())).toEqual(new Set([SEED_FACE]));
  });

  it('after a 409, draws the row that won — never the seed face the deploy tried to store', async () => {
    await act(async () => {
      await ensureDeviceIdentity();
    });
    await flush();
    // Another writer (the editor, another device) creates the row before the deploy lands.
    rows.set(ACCOUNT, { name: 'Zoe', avatar: OTHER_AVATAR });
    await act(async () => releaseCreate());
    await flush();
    expect(drawn(seen[seen.length - 1])).toBe(`Zoe|${OTHER_AVATAR}`);
    expect(drawnSinceSettled()).not.toContain(ACCOUNT_FACE);
  });

  it('a FAILED read-back keeps the seed face — never the account id’s', async () => {
    await act(async () => {
      await ensureDeviceIdentity();
    });
    await flush();
    unavailable = true;
    await act(async () => releaseCreate());
    await flush();
    expect(log).toEqual([`GET ${ACCOUNT}`, 'POST', `GET ${ACCOUNT}`]);
    expect(drawn(seen[seen.length - 1])).toBe(SEED_FACE);
    expect(new Set(drawnSinceSettled())).toEqual(new Set([SEED_FACE]));
  });

  it('a GONE account settles on no face: the seed face never stands in for it', async () => {
    await act(async () => {
      await ensureDeviceIdentity();
    });
    await flush();
    gone.add(ACCOUNT);
    await act(async () => releaseCreate());
    await flush();
    expect(seen[seen.length - 1]).toBe('gone');
  });
});

describe('the own face after a SAVE', () => {
  it('re-reads the saved face, the previous one standing while the read is out', async () => {
    await act(async () => root.unmount());
    window.localStorage.setItem(
      'whippin-device',
      JSON.stringify({ token: TOKEN, accountId: ACCOUNT, deviceId: DEVICE }),
    );
    rows.set(ACCOUNT, { name: 'Old', avatar: null });
    loadDeviceIdentity();
    await flush();
    seen = [];
    root = createRoot(container);
    await act(async () => root.render(<Probe />));
    await flush();
    expect(drawn(seen[seen.length - 1])).toBe(`Old|${defaultAvatar(ACCOUNT)}`);

    rows.set(ACCOUNT, { name: 'New', avatar: OTHER_AVATAR });
    await act(async () => ownProfileWritten());
    await flush();
    expect(drawn(seen[seen.length - 1])).toBe(`New|${OTHER_AVATAR}`);
    expect(drawnSinceSettled()).not.toContain(null);
  });

  it('a FAILED re-read changes nothing: the settled face stands', async () => {
    await act(async () => root.unmount());
    window.localStorage.setItem(
      'whippin-device',
      JSON.stringify({ token: TOKEN, accountId: ACCOUNT, deviceId: DEVICE }),
    );
    rows.set(ACCOUNT, { name: 'Zoe', avatar: OTHER_AVATAR });
    loadDeviceIdentity();
    await flush();
    seen = [];
    root = createRoot(container);
    await act(async () => root.render(<Probe />));
    await flush();
    expect(drawn(seen[seen.length - 1])).toBe(`Zoe|${OTHER_AVATAR}`);

    unavailable = true;
    await act(async () => ownProfileWritten());
    await flush();
    expect(log[log.length - 1]).toBe(`GET ${ACCOUNT}`);
    expect(new Set(drawnSinceSettled())).toEqual(new Set([`Zoe|${OTHER_AVATAR}`]));
  });
});

describe('the own face when its FIRST read fails', () => {
  async function mountOn(account: string) {
    await act(async () => root.unmount());
    window.localStorage.setItem(
      'whippin-device',
      JSON.stringify({ token: TOKEN, accountId: account, deviceId: DEVICE }),
    );
    loadDeviceIdentity();
    await flush();
    seen = [];
    root = createRoot(container);
    await act(async () => root.render(<Probe />));
    await flush();
  }

  it('settles FAILED — never the account id\u2019s assigned stranger', async () => {
    rows.set(ACCOUNT, { name: 'Zoe', avatar: OTHER_AVATAR });
    unavailable = true;
    await mountOn(ACCOUNT);
    expect(seen[seen.length - 1]).toBe('failed');
    expect(seen.map(drawn)).not.toContain(ACCOUNT_FACE);
  });

  it('asked again, it waits for the read, then lands the stored face', async () => {
    rows.set(ACCOUNT, { name: 'Zoe', avatar: OTHER_AVATAR });
    unavailable = true;
    await mountOn(ACCOUNT);
    expect(seen[seen.length - 1]).toBe('failed');

    unavailable = false;
    seen = [];
    await act(async () => retryOwnFace());
    await flush();
    // The box breathes while the read is out (null), and the face lands — nothing between.
    expect(seen).toContain(null);
    expect(drawn(seen[seen.length - 1])).toBe(`Zoe|${OTHER_AVATAR}`);
    expect(seen.map(drawn)).not.toContain(ACCOUNT_FACE);
  });

  it('a retry that fails again rests on FAILED', async () => {
    unavailable = true;
    await mountOn(ACCOUNT);
    await act(async () => retryOwnFace());
    await flush();
    expect(seen[seen.length - 1]).toBe('failed');
  });
});
