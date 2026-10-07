// CONTRACT (#216): a device holds a REVOCABLE token, the server assigns the account, and
// signing a device out is possible WITHOUT holding it.
//
// What is pinned here is the protocol and the rules that make revocation mean something:
// the token's canonical shape is checked before anything is hashed or read; the bootstrap
// is Turnstile-gated and IDEMPOTENT by token hash (a lost answer must not mint a second
// identity); an arbitrary unknown token is `unknown_device` and never a fresh account; a
// revoked device's next call is signed out; and no answer ever carries the token back.

import { describe, expect, it, vi } from 'vitest';
import { DEVICE_ID_PATTERN, PUBLIC_ID_PATTERN } from '@whippin/shared';
import { createHandler } from './handler';
import { emailHash } from './linkStore';
import { consoleMailer } from './mailer';
import { memoryDeviceStore } from './memoryDeviceStore';
import { memoryGroupStore } from './memoryGroupStore';
import { memoryHistoryStore } from './memoryHistoryStore';
import { memoryLinkStore } from './memoryLinkStore';
import { memoryProfileStore } from './memoryProfileStore';
import { memoryRoundStore } from './memoryRoundStore';
import { memoryScoreStore } from './memoryScoreStore';
import {
  deviceTokenHash,
  staleLastSeen,
  type DeviceRecord,
  type DeviceStore,
} from './deviceStore';
import { parseUserAgent } from './userAgent';
import type { FnUrlEvent } from './respond';
import type { PuzzleStore } from './store';

const emptyStore: PuzzleStore = {
  getPuzzle: async () => null,
  hasPuzzle: async () => false,
  getSlice: async () => null,
};

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

function makeHandler(options: { turnstile?: boolean; devices?: DeviceStore } = {}) {
  const deviceStore = options.devices ?? memoryDeviceStore();
  const handler = createHandler({
    store: emptyStore,
    deviceStore,
    devices: {
      turnstile: { async verify() { return options.turnstile !== false; } },
      allowSourceIp: true,
    },
  });
  return Object.assign(handler, { deviceStore });
}

function post(body: unknown, userAgent = IPHONE): FnUrlEvent {
  return {
    rawPath: '/devices',
    headers: { 'user-agent': userAgent },
    requestContext: { http: { method: 'POST', sourceIp: '203.0.113.7' } },
    body: JSON.stringify(body),
  };
}

const TOKEN = 'a1'.repeat(32);
const OTHER_TOKEN = 'b2'.repeat(32);

interface Listing {
  accountId: string;
  deviceId: string;
  devices: {
    revokeKey: string;
    deviceId: string;
    device: string;
    os: string;
    browser: string;
    createdAt: string;
    lastSeenAt: string;
    current: boolean;
  }[];
}

function row(listing: Listing, deviceId: string) {
  const found = listing.devices.find((device) => device.deviceId === deviceId);
  if (!found) throw new Error(`missing listed device ${deviceId}`);
  return found;
}

async function bootstrap(
  handler: ReturnType<typeof makeHandler>,
  token: string,
  userAgent = IPHONE,
): Promise<Listing> {
  const result = await handler(post({ token, turnstileToken: 'ok' }, userAgent));
  expect(result.statusCode).toBe(200);
  return JSON.parse(result.body) as Listing;
}

describe('device bootstrap (#216)', () => {
  it('assigns an account and a device, and never echoes the token back', async () => {
    const handler = makeHandler();
    const result = await handler(post({ token: TOKEN, turnstileToken: 'ok' }));
    expect(result.statusCode).toBe(200);
    expect(result.headers['Cache-Control']).toBe('no-store');
    const body = JSON.parse(result.body) as Listing;
    expect(body.accountId).toMatch(PUBLIC_ID_PATTERN);
    expect(body.deviceId).toMatch(DEVICE_ID_PATTERN);
    expect(row(body, body.deviceId).revokeKey).toMatch(/^[0-9a-f]{64}$/);
    // The client already holds the token; sending it back would put it in a response the
    // CDN, a log or a proxy could see.
    expect(result.body).not.toContain(TOKEN);
  });

  it('is IDEMPOTENT by token hash — a retried bootstrap is the SAME identity', async () => {
    const handler = makeHandler();
    const first = await bootstrap(handler, TOKEN);
    // Exactly the case a lost answer after a committed write produces. Minting a second
    // identity here would silently split a player in two.
    const second = await bootstrap(handler, TOKEN);
    expect(second.accountId).toBe(first.accountId);
    expect(second.deviceId).toBe(first.deviceId);
    expect(second.devices).toHaveLength(1);
  });

  it('gives two tokens two accounts', async () => {
    const handler = makeHandler();
    const one = await bootstrap(handler, TOKEN);
    const two = await bootstrap(handler, OTHER_TOKEN);
    expect(two.accountId).not.toBe(one.accountId);
  });

  it('stores the user agent the SERVER read, as fields', async () => {
    const handler = makeHandler();
    const body = await bootstrap(handler, TOKEN);
    expect(body.devices[0]).toMatchObject({ device: 'iPhone', browser: 'Safari', current: true });
    expect(body.devices[0].os.startsWith('iOS')).toBe(true);
  });

  it('refuses a rejected challenge, and creates nothing', async () => {
    const handler = makeHandler({ turnstile: false });
    const result = await handler(post({ token: TOKEN, turnstileToken: 'nope' }));
    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body).error).toBe('turnstile_rejected');
    await expect(handler.deviceStore.resolve(deviceTokenHash(TOKEN))).resolves.toBeNull();
  });

  it('refuses a non-canonical token BEFORE anything is hashed or stored', async () => {
    const handler = makeHandler();
    // Uppercase is refused, never normalized: one token must key exactly one row.
    for (const token of [undefined, '', 'A1'.repeat(32), 'a'.repeat(63), 'a'.repeat(65), 'zz'.repeat(32)]) {
      const result = await handler(post({ token, turnstileToken: 'ok' }));
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toBe('bad_request');
    }
  });

  it('lists the device it just created even when the INDEX has not caught up', async () => {
    // The list comes off a GSI, which is eventually consistent by design. A bootstrap
    // answering with an empty device list would contradict the write it just made, so the
    // answer is corrected from what the request already knows.
    const base = memoryDeviceStore();
    const lagging: DeviceStore = { ...base, list: async () => [] };
    const handler = makeHandler({ devices: lagging });
    const body = await bootstrap(handler, TOKEN);
    expect(body.devices.map((row) => row.deviceId)).toEqual([body.deviceId]);
    expect(body.devices[0].current).toBe(true);
  });

  it('refuses a body that both bootstraps and revokes', async () => {
    const handler = makeHandler();
    const result = await handler(
      post({ token: TOKEN, turnstileToken: 'ok', revoke: 'a'.repeat(16) }),
    );
    expect(result.statusCode).toBe(400);
  });
});

describe('the sign-out screen (#216)', () => {
  it('lists the ACCOUNT\'s devices and marks the calling one', async () => {
    const handler = makeHandler();
    const phone = await bootstrap(handler, TOKEN);
    // A second device on the same account is what #204's email link produces; here it is
    // seeded directly, since #216 ships before that flow.
    const laptop = await handler.deviceStore.bootstrap({
      tokenHash: deviceTokenHash(OTHER_TOKEN),
      accountId: phone.accountId,
      deviceId: 'q'.repeat(16),
      agent: { device: 'Mac', os: 'macOS', browser: 'Chrome' },
      now: '2026-08-23T00:00:00.000Z',
    });

    const listed = JSON.parse((await handler(post({ token: TOKEN }))).body) as Listing;
    expect(listed.devices.map((row) => row.deviceId).sort()).toEqual(
      [phone.deviceId, laptop.device.deviceId].sort(),
    );
    expect(listed.devices.find((row) => row.current)?.deviceId).toBe(phone.deviceId);
  });

  it('SIGNS OUT another device without holding it, and that device is then unknown', async () => {
    const handler = makeHandler();
    const phone = await bootstrap(handler, TOKEN);
    const laptop = await bootstrap(handler, OTHER_TOKEN);
    // Two separate accounts here would defeat the point, so put the laptop on the phone's.
    await handler.deviceStore.revoke(
      laptop.accountId,
      laptop.deviceId,
      row(laptop, laptop.deviceId).revokeKey,
    );
    const shared = await handler.deviceStore.bootstrap({
      tokenHash: deviceTokenHash(OTHER_TOKEN),
      accountId: phone.accountId,
      deviceId: 'q'.repeat(16),
      agent: { device: 'Mac', os: 'macOS', browser: 'Chrome' },
      now: '2026-08-23T00:00:00.000Z',
    });

    const after = JSON.parse(
      (
        await handler(
          post({
            token: TOKEN,
            revoke: shared.device.deviceId,
            revokeKey: shared.device.revokeKey,
          }),
        )
      ).body,
    ) as Listing;
    expect(after.devices.map((row) => row.deviceId)).toEqual([phone.deviceId]);

    // The revoked device's next authenticated call is the distinct signed-out answer — and
    // it does NOT quietly become a fresh account.
    const signedOut = await handler(post({ token: OTHER_TOKEN }));
    expect(signedOut.statusCode).toBe(401);
    expect(JSON.parse(signedOut.body).error).toBe('unknown_device');
  });

  it('may sign out the CALLING device — that is a thing a person may want', async () => {
    const handler = makeHandler();
    const phone = await bootstrap(handler, TOKEN);
    const after = JSON.parse(
      (
        await handler(
          post({
            token: TOKEN,
            revoke: phone.deviceId,
            revokeKey: row(phone, phone.deviceId).revokeKey,
          }),
        )
      ).body,
    ) as Listing;
    expect(after.devices).toEqual([]);
    expect((await handler(post({ token: TOKEN }))).statusCode).toBe(401);
  });

  it('does not let a concurrent self-revocation reappear through a stale GSI row', async () => {
    const base = memoryDeviceStore();
    let staleRows: DeviceRecord[] | null = null;
    const concurrent: DeviceStore = {
      ...base,
      async list(accountId) {
        return staleRows ?? base.list(accountId);
      },
      async revoke(accountId, deviceId, revokeKey) {
        // The other request wins after this request authenticated but before its delete.
        // Dynamo's lagging index can still return the row it removed.
        staleRows = await base.list(accountId);
        await base.revoke(accountId, deviceId, revokeKey);
        return 'absent';
      },
    };
    const handler = makeHandler({ devices: concurrent });
    const phone = await bootstrap(handler, TOKEN);

    const after = JSON.parse(
      (
        await handler(
          post({
            token: TOKEN,
            revoke: phone.deviceId,
            revokeKey: row(phone, phone.deviceId).revokeKey,
          }),
        )
      ).body,
    ) as Listing;

    expect(after.devices).toEqual([]);
    await expect(base.resolve(deviceTokenHash(TOKEN))).resolves.toBeNull();
  });

  it('cannot revoke a device on somebody else\'s account', async () => {
    const handler = makeHandler();
    await bootstrap(handler, TOKEN);
    const stranger = await bootstrap(handler, OTHER_TOKEN);
    const result = await handler(
      post({
        token: TOKEN,
        revoke: stranger.deviceId,
        revokeKey: row(stranger, stranger.deviceId).revokeKey,
      }),
    );
    expect(result.statusCode).toBe(200);
    // Nothing removed, and the stranger's device still authenticates.
    expect((await handler(post({ token: OTHER_TOKEN }))).statusCode).toBe(200);
  });

  it('refuses a malformed revoke target and a GET', async () => {
    const handler = makeHandler();
    const phone = await bootstrap(handler, TOKEN);
    expect((await handler(post({ token: TOKEN, revoke: 'NOPE' }))).statusCode).toBe(400);
    expect((await handler(post({ token: TOKEN, revoke: 42 }))).statusCode).toBe(400);
    expect((await handler(post({ token: TOKEN, revoke: phone.deviceId }))).statusCode).toBe(400);
    expect(
      (
        await handler(
          post({ token: TOKEN, revoke: phone.deviceId, revokeKey: 'not-a-handle' }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await handler(
          post({ token: TOKEN, revokeKey: row(phone, phone.deviceId).revokeKey }),
        )
      ).statusCode,
    ).toBe(400);
    const read = await handler({
      rawPath: '/devices',
      requestContext: { http: { method: 'GET' } },
    });
    expect(read.statusCode).toBe(405);
  });

  it('answers an UNKNOWN token unknown_device rather than creating one', async () => {
    const handler = makeHandler();
    const result = await handler(post({ token: TOKEN }));
    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body).error).toBe('unknown_device');
    // Emphatically NOT created: only the explicit gated bootstrap may mint an identity.
    await expect(handler.deviceStore.resolve(deviceTokenHash(TOKEN))).resolves.toBeNull();
  });
});

describe('what the store keys and stamps (#216)', () => {
  it('stores the token HASH, never the token', () => {
    // Deterministic, so authentication is one direct read — and a table dump
    // authenticates nobody.
    const hash = deviceTokenHash(TOKEN);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(TOKEN);
    expect(deviceTokenHash(TOKEN)).toBe(hash);
    expect(deviceTokenHash(OTHER_TOKEN)).not.toBe(hash);
  });

  it('moves lastSeenAt at most once a DAY — this rides every authenticated call', () => {
    expect(staleLastSeen('2026-08-23T00:00:00.000Z', '2026-08-23T23:59:59.000Z')).toBe(false);
    expect(staleLastSeen('2026-08-23T23:59:59.000Z', '2026-08-24T00:00:00.000Z')).toBe(true);
  });
});

describe('what a device IS, read from the User-Agent (#216)', () => {
  it('names the families a person recognises', () => {
    expect(parseUserAgent(IPHONE)).toEqual({ device: 'iPhone', os: 'iOS 17', browser: 'Safari' });
    expect(
      parseUserAgent(
        'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/124.0.0.0 Mobile Safari/537.36',
      ),
    ).toEqual({ device: 'Android', os: 'Android 14', browser: 'Chrome' });
    expect(
      parseUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/124.0.0.0 Safari/537.36',
      ),
    ).toEqual({ device: 'Mac', os: 'macOS', browser: 'Chrome' });
  });

  it('tells the Chromium impersonators apart — the ORDER is the whole parser', () => {
    // Every one of these also claims Chrome, and Chrome claims Safari.
    const edge =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0';
    expect(parseUserAgent(edge)).toEqual({ device: 'Windows', os: 'Windows', browser: 'Edge' });
    const samsung =
      'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36';
    expect(parseUserAgent(samsung).browser).toBe('Samsung Internet');
    const firefoxIos =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 ' +
      '(KHTML, like Gecko) FxiOS/125.0 Mobile/15E148 Safari/605.1.15';
    expect(parseUserAgent(firefoxIos).browser).toBe('Firefox');
  });

  it('leaves what it cannot read EMPTY rather than guessing', () => {
    expect(parseUserAgent(undefined)).toEqual({ device: '', os: '', browser: '' });
    expect(parseUserAgent('curl/8.4.0')).toEqual({ device: '', os: '', browser: '' });
  });
});

// CONTRACT (#207): a player deletes their own account. The body NAMES the account it
// deletes; the deletion is ONE commit after which the account is gone for every surface —
// no token of it authenticates, no profile read dresses it, its address reaches nobody —
// and a purge job is queued for the rest. Devices and groups go at once, best-effort: the
// answer is about the deletion, which has already happened.
describe('deleting an account (#207)', () => {
  function world() {
    const devices = memoryDeviceStore();
    const profiles = memoryProfileStore((id) => devices.accountExists(id));
    const groups = memoryGroupStore((id) => devices.accountExists(id));
    const rounds = memoryRoundStore();
    const scores = memoryScoreStore();
    const history = memoryHistoryStore();
    const links = memoryLinkStore({ devices, profiles, rounds, scores, history });
    const handler = createHandler({
      store: emptyStore,
      profiles,
      groups,
      deviceStore: devices,
      devices: { turnstile: { verify: async () => true }, allowSourceIp: true },
      link: {
        links,
        groups,
        history,
        mailer: consoleMailer,
        turnstile: { verify: async () => true },
        ipHmacSecret: 'x'.repeat(32),
        allowSourceIp: true,
      },
    });
    return { handler, devices, profiles, groups, links };
  }

  async function signedUp(harnessed: ReturnType<typeof world>, token = TOKEN) {
    const result = await harnessed.handler(post({ token, turnstileToken: 'ok' }));
    return JSON.parse(result.body) as Listing;
  }

  // Bind an address the way a verified link does: a standing challenge consumed by `bind`.
  async function linkEmail(harnessed: ReturnType<typeof world>, accountId: string, email: string) {
    const hash = emailHash(email);
    const now = '2026-08-26T12:00:00.000Z';
    await harnessed.links.putChallenge(hash, {
      codeHash: 'c'.repeat(64),
      attempts: 0,
      createdAt: now,
      expiresAt: Math.floor(Date.parse(now) / 1_000) + 600,
    });
    const outcome = await harnessed.links.bind({
      emailHash: hash,
      codeHash: 'c'.repeat(64),
      email,
      accountId,
      now,
    });
    expect(outcome).toBe('bound');
  }

  it('deletes the account: every token of it is signed out, its face is gone, a purge is queued', async () => {
    const harnessed = world();
    const me = await signedUp(harnessed);
    // A second device on the same account, and a stranger who must be left alone.
    await harnessed.devices.bootstrap({
      tokenHash: deviceTokenHash(OTHER_TOKEN),
      accountId: me.accountId,
      deviceId: 'zzzzzzzzzzzzzzzz',
      agent: { device: '', os: '', browser: '' },
      now: '2026-08-26T12:00:00.000Z',
    });
    const stranger = await signedUp(harnessed, 'c3'.repeat(32));
    await harnessed.profiles.upsert({
      publicId: me.accountId,
      name: 'Zoe',
      avatar: '',
      now: '2026-08-26T12:00:00.000Z',
    });

    const result = await harnessed.handler(post({ token: TOKEN, deleteAccount: me.accountId }));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ deleted: true });

    // Both devices fail authentication, and their items are gone now rather than at the purge.
    for (const token of [TOKEN, OTHER_TOKEN]) {
      const after = await harnessed.handler(post({ token }));
      expect(after.statusCode).toBe(401);
      expect(JSON.parse(after.body).error).toBe('unknown_device');
    }
    await expect(harnessed.devices.list(me.accountId)).resolves.toEqual([]);
    // No surface dresses the deleted account: the public profile read says it is GONE.
    const profile = await harnessed.handler({
      rawPath: '/profile',
      queryStringParameters: { id: me.accountId },
      requestContext: { http: { method: 'GET' } },
    });
    expect(profile.statusCode).toBe(410);
    // The stranger is untouched.
    expect((await harnessed.handler(post({ token: 'c3'.repeat(32) }))).statusCode).toBe(200);
    await expect(harnessed.devices.accountExists(stranger.accountId)).resolves.toBe(true);
    // The rest is owed by the purge worker.
    const jobs = await harnessed.links.pendingPurges();
    expect(jobs.map((job) => job.accountId)).toEqual([me.accountId]);
  });

  it('frees the ADDRESS: the binding goes with the account, and the job never names it', async () => {
    const harnessed = world();
    const me = await signedUp(harnessed);
    await linkEmail(harnessed, me.accountId, 'zoe@example.com');

    const result = await harnessed.handler(post({ token: TOKEN, deleteAccount: me.accountId }));
    expect(result.statusCode).toBe(200);
    await expect(harnessed.links.binding(emailHash('zoe@example.com'))).resolves.toBeNull();
    expect(JSON.stringify(await harnessed.links.pendingPurges())).not.toContain('zoe');
  });

  it('a REPLAY after a lost answer authenticates no more — 401 `unknown_device`, which the client reads as done', async () => {
    const harnessed = world();
    const me = await signedUp(harnessed);
    expect((await harnessed.handler(post({ token: TOKEN, deleteAccount: me.accountId }))).statusCode).toBe(200);
    const replay = await harnessed.handler(post({ token: TOKEN, deleteAccount: me.accountId }));
    expect(replay.statusCode).toBe(401);
    expect(JSON.parse(replay.body).error).toBe('unknown_device');
  });

  it('refuses to delete an account the body does not NAME — 409 `account_changed`, nothing goes', async () => {
    const harnessed = world();
    const me = await signedUp(harnessed);
    const other = await signedUp(harnessed, 'c3'.repeat(32));
    const result = await harnessed.handler(post({ token: TOKEN, deleteAccount: other.accountId }));
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body).error).toBe('account_changed');
    expect((await harnessed.handler(post({ token: TOKEN }))).statusCode).toBe(200);
    await expect(harnessed.devices.accountExists(me.accountId)).resolves.toBe(true);
    await expect(harnessed.links.pendingPurges()).resolves.toEqual([]);
  });

  // A store refusal says only that the snapshot this call authenticated with no longer
  // stands; the route reads the device AGAIN to tell what happened. 409 `account_changed`
  // then means exactly one thing — this device is on ANOTHER account — and the client may
  // read it so.
  it('deletes ANYWAY when only the address changed between the read and the commit — the player named this account', async () => {
    const harnessed = world();
    const me = await signedUp(harnessed);
    // The bind lands after this call authenticated (no address read) and before it commits.
    const original = harnessed.links.deleteAccount.bind(harnessed.links);
    const asked: (string | undefined)[] = [];
    harnessed.links.deleteAccount = async (input) => {
      asked.push(input.email);
      if (asked.length === 1) await linkEmail(harnessed, me.accountId, 'zoe@example.com');
      return original(input);
    };
    const result = await harnessed.handler(post({ token: TOKEN, deleteAccount: me.accountId }));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ deleted: true });
    // Tried again over the FRESH snapshot — the address it now carries — which also frees it.
    expect(asked).toEqual([undefined, 'zoe@example.com']);
    await expect(harnessed.devices.accountExists(me.accountId)).resolves.toBe(false);
    await expect(harnessed.links.binding(emailHash('zoe@example.com'))).resolves.toBeNull();
  });

  it('answers 401 `unknown_device` when ANOTHER device of the account deleted it first — the client reads that as done', async () => {
    const harnessed = world();
    const me = await signedUp(harnessed);
    await harnessed.devices.bootstrap({
      tokenHash: deviceTokenHash(OTHER_TOKEN),
      accountId: me.accountId,
      deviceId: 'zzzzzzzzzzzzzzzz',
      agent: { device: '', os: '', browser: '' },
      now: '2026-08-26T12:00:00.000Z',
    });
    const original = harnessed.links.deleteAccount.bind(harnessed.links);
    harnessed.links.deleteAccount = async (input) => {
      // The sibling's deletion commits between this call's authentication and its own.
      if (input.tokenHash === deviceTokenHash(TOKEN)) {
        await original({ ...input, tokenHash: deviceTokenHash(OTHER_TOKEN) });
      }
      return original(input);
    };
    const result = await harnessed.handler(post({ token: TOKEN, deleteAccount: me.accountId }));
    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body).error).toBe('unknown_device');
    await expect(harnessed.devices.accountExists(me.accountId)).resolves.toBe(false);
  });

  it('answers 409 `account_changed` when a LINK moved this device to another account meanwhile — and deletes neither', async () => {
    const harnessed = world();
    const me = await signedUp(harnessed);
    const other = await signedUp(harnessed, 'c3'.repeat(32));
    // A saved account (it has an address), so the link on a sibling tab leaves it standing.
    await linkEmail(harnessed, me.accountId, 'zoe@example.com');
    const original = harnessed.links.deleteAccount.bind(harnessed.links);
    harnessed.links.deleteAccount = async (input) => {
      expect(
        harnessed.devices.adoptDevice({
          tokenHash: deviceTokenHash(TOKEN),
          deviceId: me.deviceId,
          from: me.accountId,
          to: other.accountId,
          erase: false,
          now: '2026-08-26T12:00:00.000Z',
        }),
      ).toBe('adopted');
      return original(input);
    };
    const result = await harnessed.handler(post({ token: TOKEN, deleteAccount: me.accountId }));
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body).error).toBe('account_changed');
    // The account it LEFT still stands, and so does the one it holds now.
    await expect(harnessed.devices.accountExists(me.accountId)).resolves.toBe(true);
    await expect(harnessed.devices.accountExists(other.accountId)).resolves.toBe(true);
    await expect(harnessed.links.pendingPurges()).resolves.toEqual([]);
  });

  it('fails LOUDLY after three refusals on an account that keeps changing — never a guessed answer', async () => {
    const harnessed = world();
    const me = await signedUp(harnessed);
    let calls = 0;
    harnessed.links.deleteAccount = async () => {
      calls += 1;
      return 'account_changed';
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await harnessed.handler(post({ token: TOKEN, deleteAccount: me.accountId }));
      expect(result.statusCode).toBe(500);
    } finally {
      error.mockRestore();
    }
    expect(calls).toBe(3);
    await expect(harnessed.devices.accountExists(me.accountId)).resolves.toBe(true);
  });

  it('refuses a malformed name, and a body that also bootstraps or revokes — 400 `bad_request`', async () => {
    const harnessed = world();
    const me = await signedUp(harnessed);
    for (const body of [
      { token: TOKEN, deleteAccount: 'NOT-AN-ID' },
      { token: TOKEN, deleteAccount: 42 },
      { token: TOKEN, deleteAccount: me.accountId, turnstileToken: 'ok' },
      { token: TOKEN, deleteAccount: me.accountId, revoke: me.deviceId },
      { token: TOKEN, deleteAccount: me.accountId, revokeKey: 'a'.repeat(64) },
    ]) {
      const result = await harnessed.handler(post(body));
      expect(result.statusCode, JSON.stringify(body)).toBe(400);
      expect(JSON.parse(result.body).error).toBe('bad_request');
    }
    await expect(harnessed.devices.accountExists(me.accountId)).resolves.toBe(true);
  });

  it('authenticates like every private call: a malformed token is 400, an unknown one 401', async () => {
    const harnessed = world();
    const id = 'aaaaaaaaaaaaaaaa';
    expect((await harnessed.handler(post({ token: 'nope', deleteAccount: id }))).statusCode).toBe(400);
    const unknown = await harnessed.handler(post({ token: TOKEN, deleteAccount: id }));
    expect(unknown.statusCode).toBe(401);
    expect(JSON.parse(unknown.body).error).toBe('unknown_device');
  });

  it('LEAVES every group at once, under the succession rule — an owned group goes to the oldest other member', async () => {
    const harnessed = world();
    const me = await signedUp(harnessed);
    const second = await signedUp(harnessed, 'c3'.repeat(32));
    const third = await signedUp(harnessed, 'd4'.repeat(32));
    const at = (minute: number) => `2026-08-26T12:0${minute}:00.000Z`;
    await harnessed.groups.create({ id: 'gaaaaaaaaaaaaaaa', name: 'crew', createdBy: me.accountId, now: at(0) });
    await harnessed.groups.join({ id: 'gaaaaaaaaaaaaaaa', publicId: second.accountId, now: at(1) });
    await harnessed.groups.join({ id: 'gaaaaaaaaaaaaaaa', publicId: third.accountId, now: at(2) });
    // A group of one: left, it is deleted.
    await harnessed.groups.create({ id: 'gbbbbbbbbbbbbbbb', name: 'solo', createdBy: me.accountId, now: at(3) });

    expect((await harnessed.handler(post({ token: TOKEN, deleteAccount: me.accountId }))).statusCode).toBe(200);
    await expect(harnessed.groups.listMine(me.accountId)).resolves.toEqual([]);
    const crew = await harnessed.groups.get('gaaaaaaaaaaaaaaa');
    expect(crew?.createdBy).toBe(second.accountId);
    expect((await harnessed.groups.members('gaaaaaaaaaaaaaaa')).map((m) => m.publicId)).toEqual([
      second.accountId,
      third.accountId,
    ]);
    await expect(harnessed.groups.get('gbbbbbbbbbbbbbbb')).resolves.toBeNull();
  });

  it('answers the deletion even when the steps after the commit FAIL — they are owed by the purge', async () => {
    const harnessed = world();
    const me = await signedUp(harnessed);
    harnessed.groups.leaveAll = async () => {
      throw new Error('throttled');
    };
    harnessed.devices.list = async () => {
      throw new Error('throttled');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = await harnessed.handler(post({ token: TOKEN, deleteAccount: me.accountId }));
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ deleted: true });
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
    await expect(harnessed.links.pendingPurges()).resolves.toHaveLength(1);
  });
});
