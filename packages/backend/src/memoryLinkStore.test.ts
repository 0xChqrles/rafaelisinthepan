import { describe, expect, it } from 'vitest';
import { LINK_CODE_MAX_ATTEMPTS } from '@whippin/shared';
import { memoryDeviceStore } from './memoryDeviceStore';
import { memoryLinkStore } from './memoryLinkStore';
import { memoryProfileStore } from './memoryProfileStore';
import { deviceTokenHash } from './deviceStore';
import { emailHash, type LinkChallenge } from './linkStore';
import { deviceSeed, newTestDevice } from './testDevice';

// CONTRACT: the memory store answers like the production one. It is the store
// `backend:dev` and every route test runs on, so a rule it spells differently is a rule
// those tests cannot see — the memory ROUND store's own reason for having a suite.

const HASH = 'e'.repeat(64);
const NOW = new Date('2026-08-26T12:00:00.000Z');
const RIGHT = 'c'.repeat(64);
const WRONG = 'd'.repeat(64);
const ME = newTestDevice();
const OTHER = newTestDevice();

function store() {
  return memoryLinkStore({
    devices: {
      bindAccountEmail: () => true,
      adoptDevice: () => 'adopted',
      deleteAccount: () => true,
    },
    profiles: { remove: () => undefined },
    rounds: { move: () => null },
    scores: { move: () => undefined },
    history: { purge: () => undefined },
  });
}

const challenge = (): LinkChallenge => ({
  codeHash: RIGHT,
  attempts: 0,
  createdAt: NOW.toISOString(),
  expiresAt: Math.floor(NOW.getTime() / 1_000) + 600,
});

describe('memoryLinkStore.verify — the attempt ladder (#204)', () => {
  // A COUNTED mismatch is `wrong`, the LAST one included, with nothing left. `spent` is
  // what the NEXT call gets. Calling the fifth mismatch `spent` answered a 409 for a code
  // the player actually typed wrong, and left the screen unable to say how it ended.
  it('answers attempts 1 through 5 `wrong` — counting down to ZERO — and the sixth `spent`', async () => {
    const links = store();
    await links.putChallenge(HASH, challenge());

    const seen = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      seen.push(await links.verify(HASH, WRONG, NOW));
    }
    expect(seen).toEqual([
      { outcome: 'wrong', attemptsLeft: 4 },
      { outcome: 'wrong', attemptsLeft: 3 },
      { outcome: 'wrong', attemptsLeft: 2 },
      { outcome: 'wrong', attemptsLeft: 1 },
      { outcome: 'wrong', attemptsLeft: 0 },
      { outcome: 'spent', attemptsLeft: 0 },
    ]);
    expect(LINK_CODE_MAX_ATTEMPTS).toBe(5);
  });

  it('spends NO attempt on a correct code — one successful link verifies twice', async () => {
    const links = store();
    await links.putChallenge(HASH, challenge());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(links.verify(HASH, RIGHT, NOW)).resolves.toEqual({
        outcome: 'ok',
        attemptsLeft: LINK_CODE_MAX_ATTEMPTS,
      });
    }
  });

  it('answers an exhausted challenge `spent` even for the RIGHT code', async () => {
    const links = store();
    await links.putChallenge(HASH, challenge());
    for (let attempt = 0; attempt < LINK_CODE_MAX_ATTEMPTS; attempt += 1) {
      await links.verify(HASH, WRONG, NOW);
    }
    await expect(links.verify(HASH, RIGHT, NOW)).resolves.toEqual({
      outcome: 'spent',
      attemptsLeft: 0,
    });
  });

  it('a RESEND replaces the challenge, attempts and all', async () => {
    const links = store();
    await links.putChallenge(HASH, challenge());
    await links.verify(HASH, WRONG, NOW);
    await links.putChallenge(HASH, challenge());
    await expect(links.verify(HASH, WRONG, NOW)).resolves.toEqual({
      outcome: 'wrong',
      attemptsLeft: LINK_CODE_MAX_ATTEMPTS - 1,
    });
  });
});

// CONTRACT: a code lives LINK_CODE_TTL_SECONDS, and the stored `expiresAt` is what the
// store enforces — the table's own TTL deletion lags, so a challenge still held past its
// instant keeps answering `expired` until a resend replaces it.
describe('memoryLinkStore — an expired challenge (#204)', () => {
  const EXPIRY = new Date(challenge().expiresAt * 1_000);
  const BEFORE = new Date(EXPIRY.getTime() - 1_000);

  it('answers `expired` AT its instant, for the right code and a wrong one, counting no attempt', async () => {
    const links = store();
    await links.putChallenge(HASH, challenge());
    const expired = { outcome: 'expired', attemptsLeft: 0 };
    await expect(links.verify(HASH, RIGHT, EXPIRY)).resolves.toEqual(expired);
    await expect(links.verify(HASH, WRONG, EXPIRY)).resolves.toEqual(expired);
    // Asked again it is STILL expired — never "no code was asked for".
    await expect(links.verify(HASH, WRONG, EXPIRY)).resolves.toEqual(expired);
    // Read a second before its instant, the challenge shows every attempt it started with:
    // the expired calls spent none.
    await expect(links.verify(HASH, WRONG, BEFORE)).resolves.toEqual({
      outcome: 'wrong',
      attemptsLeft: LINK_CODE_MAX_ATTEMPTS - 1,
    });
  });

  it('refuses to BIND on an expired challenge, and creates no binding', async () => {
    const links = store();
    await links.putChallenge(HASH, challenge());
    const bind = (now: Date) =>
      links.bind({
        emailHash: HASH,
        codeHash: RIGHT,
        email: 'zoe@example.com',
        accountId: 'aaaaaaaaaaaaaaaa',
        now: now.toISOString(),
      });
    await expect(bind(EXPIRY)).resolves.toBe('challenge_changed');
    await expect(links.binding(HASH)).resolves.toBeNull();
    // The same call a second earlier is the one that binds.
    await expect(bind(BEFORE)).resolves.toBe('bound');
  });
});

describe('memoryLinkStore.binding (#204)', () => {
  it('answers WHICH account an address reaches, and nothing else', async () => {
    const links = store();
    await links.putChallenge(HASH, challenge());
    await expect(
      links.bind({
        emailHash: HASH,
        codeHash: RIGHT,
        email: 'zoe@example.com',
        accountId: 'aaaaaaaaaaaaaaaa',
        now: NOW.toISOString(),
      }),
    ).resolves.toBe('bound');
    // A binding carries the account id ALONE — the `createdAt` it used to hold was read by
    // nothing, and an attribute nothing reads is a field that drifts (PR-227 review).
    await expect(links.binding(HASH)).resolves.toEqual({ accountId: 'aaaaaaaaaaaaaaaa' });
  });
});

// CONTRACT (#207): the memory deletion decides every condition before it changes anything,
// the production transaction's rule.
describe('memoryLinkStore.deleteAccount (#207)', () => {
  function linked() {
    const devices = memoryDeviceStore([deviceSeed(ME), deviceSeed(OTHER)]);
    const profiles = memoryProfileStore((id) => devices.accountExists(id));
    const links = memoryLinkStore({
      devices,
      profiles,
      rounds: { move: () => null },
      scores: { move: () => undefined },
      history: { purge: () => undefined },
    });
    return { devices, profiles, links };
  }

  async function bindTo(links: ReturnType<typeof linked>['links'], hash: string, accountId: string) {
    await links.putChallenge(hash, challenge());
    await links.bind({ emailHash: hash, codeHash: RIGHT, email: 'zoe@example.com', accountId, now: NOW.toISOString() });
  }

  it('refuses an account whose address is no longer the one read — nothing changes', async () => {
    const { devices, links } = linked();
    await bindTo(links, emailHash('zoe@example.com'), ME.accountId);
    await expect(
      links.deleteAccount({
        accountId: ME.accountId,
        tokenHash: deviceTokenHash(ME.token),
        now: NOW.toISOString(),
      }),
    ).resolves.toBe('account_changed');
    await expect(devices.accountExists(ME.accountId)).resolves.toBe(true);
    await expect(links.pendingPurges()).resolves.toEqual([]);
  });

  it('THROWS, with nothing written, when the address reaches ANOTHER account', async () => {
    const { devices, links } = linked();
    // A table that contradicts itself: OTHER holds the binding, ME's row claims the address.
    await bindTo(links, emailHash('zoe@example.com'), OTHER.accountId);
    devices.bindAccountEmail(ME.accountId, 'zoe@example.com');
    await expect(
      links.deleteAccount({
        accountId: ME.accountId,
        tokenHash: deviceTokenHash(ME.token),
        email: 'zoe@example.com',
        now: NOW.toISOString(),
      }),
    ).rejects.toThrow();
    await expect(devices.accountExists(ME.accountId)).resolves.toBe(true);
    await expect(links.binding(emailHash('zoe@example.com'))).resolves.toEqual({
      accountId: OTHER.accountId,
    });
    await expect(links.pendingPurges()).resolves.toEqual([]);
  });

  // B2: a link on a sibling tab moved the calling device onto another account between the
  // authentication and the commit. The account it LEFT is not deleted on its say-so.
  it('refuses when the CALLING device no longer belongs to the account — nothing changes', async () => {
    const { devices, links } = linked();
    await expect(
      links.deleteAccount({
        accountId: ME.accountId,
        tokenHash: deviceTokenHash(OTHER.token),
        now: NOW.toISOString(),
      }),
    ).resolves.toBe('account_changed');
    await expect(devices.accountExists(ME.accountId)).resolves.toBe(true);
    await expect(links.pendingPurges()).resolves.toEqual([]);
  });
});

// CONTRACT (#207): an account a LINK erases is a deleted account like any other — the
// adoption queues its purge job in the same critical section, so its other days' rounds,
// scores, collections and device rows are erased too. One that survives queues nothing.
describe('memoryLinkStore.adopt — the erased account\'s purge (#207)', () => {
  const adoption = (erase: boolean) => ({
    tokenHash: deviceTokenHash(ME.token),
    deviceId: ME.deviceId,
    from: ME.accountId,
    to: OTHER.accountId,
    erase,
    emailHash: HASH,
    codeHash: RIGHT,
    now: NOW.toISOString(),
  });

  it('queues the purge of the account it ERASES', async () => {
    const links = store();
    await links.putChallenge(HASH, challenge());
    await expect(links.adopt(adoption(true))).resolves.toEqual({ outcome: 'adopted', moved: [] });
    await expect(links.pendingPurges()).resolves.toEqual([
      { accountId: ME.accountId, enqueuedAt: NOW.toISOString() },
    ]);
  });

  it('queues nothing when the account it leaves SURVIVES, or when the adoption is refused', async () => {
    const links = store();
    await links.putChallenge(HASH, challenge());
    await expect(links.adopt(adoption(false))).resolves.toEqual({ outcome: 'adopted', moved: [] });
    // The challenge is consumed: an erase now is refused, and queues nothing either.
    await expect(links.adopt(adoption(true))).resolves.toEqual({
      outcome: 'challenge_changed',
      moved: [],
    });
    await expect(links.pendingPurges()).resolves.toEqual([]);
  });
});
