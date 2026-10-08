// CONTRACT (#207): what a deleted account leaves behind is ERASED by the purge — every
// round in every language, dated or bonus, the score row each dated one earned, the
// solved-day collections, any profile row a late write put back, every device item and
// every group membership — and NOTHING of anybody else's. Every step is idempotent, so a
// job run twice (or cut off and run again) ends in the same place, and a job is cleared
// only by a purge that finished.

import { describe, expect, it, vi } from 'vitest';
import { bonusAddress } from '@whippin/shared';
import { deviceTokenHash } from './deviceStore';
import { memoryDeviceStore } from './memoryDeviceStore';
import { memoryGroupStore } from './memoryGroupStore';
import { memoryHistoryStore } from './memoryHistoryStore';
import { memoryLinkStore } from './memoryLinkStore';
import { memoryProfileStore } from './memoryProfileStore';
import { memoryRoundStore } from './memoryRoundStore';
import { memoryScoreStore } from './memoryScoreStore';
import { PURGE_SETTLE_MS, purgeAccount, runPurges } from './purge';
import { roundSortKey, roundSortKeyParts, type RoundKey } from './roundStore';
import { newTestDevice, deviceSeed } from './testDevice';

const NOW = new Date('2026-08-26T12:00:00.000Z');
const LATER = NOW.getTime() + PURGE_SETTLE_MS;

function world() {
  const devices = memoryDeviceStore();
  const profiles = memoryProfileStore((id) => devices.accountExists(id));
  const groups = memoryGroupStore((id) => devices.accountExists(id));
  const rounds = memoryRoundStore();
  const scores = memoryScoreStore(() => NOW, Number.POSITIVE_INFINITY);
  const history = memoryHistoryStore();
  const links = memoryLinkStore({ devices, profiles, rounds, scores, history });
  return { devices, profiles, groups, rounds, scores, history, links };
}

// One player with a bit of everything: two dated rounds in two languages (one solved, with
// its score row and solved day), a bonus round, a profile and a group shared with a friend.
async function played(stores: ReturnType<typeof world>) {
  const me = newTestDevice();
  const friend = newTestDevice();
  await stores.devices.bootstrap(deviceSeed(me));
  await stores.devices.bootstrap(deviceSeed(friend));
  const dated: RoundKey[] = [
    { date: '2026-08-25', lang: 'fr' },
    { date: '2026-08-26', lang: 'en' },
  ];
  const bonus: RoundKey = { date: bonusAddress('1234567'), lang: 'fr' };
  for (const [index, key] of [...dated, bonus].entries()) {
    for (const player of [me, friend]) {
      await stores.rounds.append({
        ...key,
        publicId: player.accountId,
        guesses: ['chat'],
        puzzle: 'a1b2c3',
        progress: 100,
        solved: true,
        now: new Date(NOW.getTime() + index * 10_000),
      });
    }
  }
  for (const key of dated) {
    for (const player of [me, friend]) {
      await stores.scores.submit({
        ...key,
        publicId: player.accountId,
        score: 7,
        submittedAt: NOW.toISOString(),
        revision: 'a1b2c3',
        ipHash: 'f'.repeat(16),
        expiresAt: Math.floor(NOW.getTime() / 1_000) + 3_600,
        requestToken: `${player.accountId}${key.lang}${key.date}`,
      });
    }
    await stores.history.recordSolvedDay({ publicId: me.accountId, lang: key.lang, day: 200 });
    await stores.history.recordSolvedDay({ publicId: friend.accountId, lang: key.lang, day: 200 });
  }
  await stores.profiles.upsert({ publicId: me.accountId, name: 'Zoe', avatar: '', now: NOW.toISOString() });
  await stores.groups.create({ id: 'gaaaaaaaaaaaaaaa', name: 'crew', createdBy: me.accountId, now: NOW.toISOString() });
  await stores.groups.join({ id: 'gaaaaaaaaaaaaaaa', publicId: friend.accountId, now: new Date(LATER).toISOString() });
  return { me, friend, dated, bonus };
}

describe('purgeAccount (#207)', () => {
  it('erases every round, the dated scores, the collections, the devices and the memberships — and nobody else\'s', async () => {
    const stores = world();
    const { me, friend, dated } = await played(stores);
    await expect(
      stores.links.deleteAccount({
        accountId: me.accountId,
        tokenHash: deviceTokenHash(me.token),
        now: NOW.toISOString(),
      }),
    ).resolves.toBe('deleted');
    // A write that authenticated before the deletion lands after it: the profile is back.
    await stores.profiles.upsert({ publicId: me.accountId, name: 'Zoe', avatar: '', now: NOW.toISOString() });

    await expect(purgeAccount(stores, me.accountId)).resolves.toBe(true);

    await expect(stores.rounds.listKeys(me.accountId)).resolves.toEqual([]);
    for (const key of dated) {
      await expect(stores.scores.getMany(key, [me.accountId])).resolves.toEqual([]);
      await expect(stores.history.solvedDays(me.accountId, key.lang)).resolves.toEqual([]);
    }
    await expect(stores.profiles.get(me.accountId)).resolves.toEqual({ live: false, profile: null });
    await expect(stores.devices.list(me.accountId)).resolves.toEqual([]);
    await expect(stores.groups.listMine(me.accountId)).resolves.toEqual([]);

    // The friend keeps everything, and the group they now own.
    await expect(stores.rounds.listKeys(friend.accountId)).resolves.toHaveLength(3);
    for (const key of dated) {
      await expect(stores.scores.getMany(key, [friend.accountId])).resolves.toEqual([
        { publicId: friend.accountId, score: 7 },
      ]);
      await expect(stores.history.solvedDays(friend.accountId, key.lang)).resolves.toEqual([200]);
    }
    await expect(stores.devices.resolve(deviceTokenHash(friend.token))).resolves.not.toBeNull();
    await expect(stores.groups.get('gaaaaaaaaaaaaaaa')).resolves.toMatchObject({
      createdBy: friend.accountId,
    });
  });

  it('is IDEMPOTENT: a purge run again over what is already gone finishes the same way', async () => {
    const stores = world();
    const { me } = await played(stores);
    await stores.links.deleteAccount({
      accountId: me.accountId,
      tokenHash: deviceTokenHash(me.token),
      now: NOW.toISOString(),
    });
    await expect(purgeAccount(stores, me.accountId)).resolves.toBe(true);
    await expect(purgeAccount(stores, me.accountId)).resolves.toBe(true);
  });

  it('deletes a score BEFORE the round it was earned on, so a purge cut off between them can still find it', async () => {
    const stores = world();
    const { me, dated } = await played(stores);
    await stores.links.deleteAccount({
      accountId: me.accountId,
      tokenHash: deviceTokenHash(me.token),
      now: NOW.toISOString(),
    });
    const order: string[] = [];
    const removeScore = stores.scores.remove.bind(stores.scores);
    const removeRound = stores.rounds.remove.bind(stores.rounds);
    stores.scores.remove = async (key, id) => {
      order.push(`score ${key.lang}`);
      return removeScore(key, id);
    };
    stores.rounds.remove = async (key, id) => {
      order.push(`round ${key.lang}${key.date.startsWith('bonus') ? ' bonus' : ''}`);
      return removeRound(key, id);
    };
    await purgeAccount(stores, me.accountId);
    // Two dated rounds each preceded by their score; the bonus has no score to look for.
    expect(order.filter((step) => step.startsWith('score'))).toHaveLength(dated.length);
    for (const key of dated) {
      expect(order.indexOf(`score ${key.lang}`)).toBe(order.indexOf(`round ${key.lang}`) - 1);
    }
    expect(order).toContain('round fr bonus');
  });

  it('stops BEFORE anything else when the group departure fails — the membership pair is never cut', async () => {
    const stores = world();
    const { me } = await played(stores);
    await stores.links.deleteAccount({
      accountId: me.accountId,
      tokenHash: deviceTokenHash(me.token),
      now: NOW.toISOString(),
    });
    stores.groups.leaveAll = async () => {
      throw new Error('throttled');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(purgeAccount(stores, me.accountId)).resolves.toBe(false);
    } finally {
      warn.mockRestore();
    }
    await expect(stores.rounds.listKeys(me.accountId)).resolves.toHaveLength(3);
  });
});

describe('runPurges (#207)', () => {
  async function deleted(stores: ReturnType<typeof world>, at: Date) {
    const device = newTestDevice();
    await stores.devices.bootstrap(deviceSeed(device));
    await stores.links.deleteAccount({
      accountId: device.accountId,
      tokenHash: deviceTokenHash(device.token),
      now: at.toISOString(),
    });
    return device.accountId;
  }

  it('purges every settled job OLDEST FIRST and clears it; a job younger than the settle window waits', async () => {
    const stores = world();
    const older = await deleted(stores, new Date(NOW.getTime() - 60_000));
    const old = await deleted(stores, NOW);
    const fresh = await deleted(stores, new Date(LATER - 1));
    const purged: string[] = [];
    const purgePlayer = stores.links.purgePlayer.bind(stores.links);
    stores.links.purgePlayer = async (id) => {
      purged.push(id);
      return purgePlayer(id);
    };

    const run = await runPurges(stores, { deadlineMs: Number.POSITIVE_INFINITY, now: () => LATER });
    expect(run).toEqual({ jobs: 3, done: 2, left: 1, failed: 0 });
    expect(purged).toEqual([older, old]);
    await expect(stores.links.pendingPurges()).resolves.toEqual([
      { accountId: fresh, enqueuedAt: new Date(LATER - 1).toISOString() },
    ]);
  });

  it('starts no job past the DEADLINE — the rest are left for the next run, which is not a failure', async () => {
    const stores = world();
    await deleted(stores, NOW);
    await deleted(stores, NOW);
    let clock = LATER;
    const purgePlayer = stores.links.purgePlayer.bind(stores.links);
    stores.links.purgePlayer = async (id) => {
      clock += 1_000;
      return purgePlayer(id);
    };
    const run = await runPurges(stores, { deadlineMs: LATER + 500, now: () => clock });
    expect(run).toEqual({ jobs: 2, done: 1, left: 1, failed: 0 });
    await expect(stores.links.pendingPurges()).resolves.toHaveLength(1);
  });

  it('logs a FAILED job, keeps it queued, and still tries the next one', async () => {
    const stores = world();
    const broken = await deleted(stores, new Date(NOW.getTime() - 1_000));
    const fine = await deleted(stores, NOW);
    const listKeys = stores.rounds.listKeys.bind(stores.rounds);
    stores.rounds.listKeys = async (id) => {
      if (id === broken) throw new Error('throttled');
      return listKeys(id);
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const run = await runPurges(stores, { deadlineMs: Number.POSITIVE_INFINITY, now: () => LATER });
      expect(run).toEqual({ jobs: 2, done: 1, left: 0, failed: 1 });
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
    const pending = await stores.links.pendingPurges();
    expect(pending.map((job) => job.accountId)).toEqual([broken]);
    expect(pending.map((job) => job.accountId)).not.toContain(fine);
  });
});

describe('roundSortKeyParts — the round sort key\'s one inverse (#207)', () => {
  it('reads back exactly the key the formatter wrote, a bonus address included', () => {
    for (const key of [
      { date: '2026-08-26', lang: 'fr' },
      { date: bonusAddress('1234567'), lang: 'en' },
    ]) {
      expect(roundSortKeyParts(roundSortKey(key))).toEqual(key);
    }
  });

  it('throws on anything that is not a round sort key — a purge must not silently skip a row', () => {
    for (const bad of ['', 'fr', 'fr#word#2026-08-26', 'fr#sentence#', '#sentence#2026-08-26']) {
      expect(() => roundSortKeyParts(bad), bad).toThrow();
    }
  });
});
