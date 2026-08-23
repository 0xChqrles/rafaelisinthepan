// CONTRACT (#189): one click on an invite link starts ONE conversation, and the click
// never dead-ends. React may replay the landing's effect (development StrictMode) or
// remount it, and neither may mint a second request. A SUCCESS is confirmed on screen
// before continuing (user feedback 2026-08-20 — 'added'); the profile read that DRESSES
// that confirmation is best-effort AND bounded (a 6s abort), since this landing renders
// no controls until the confirmation mounts and a stalled read would otherwise leave the
// clicker with only a reload — which re-fires the POST. A non-cap 4xx is a verdict the
// player cannot argue with and continues silently; only the backend failing is worth
// retrying. TWO answers are said out loud as blockers — the failure, and the cap, which
// is a verdict the player CAN act on and would otherwise leave a full player clicking
// invitations forever, each one appearing to work.

import { describe, expect, it, vi } from 'vitest';
import { sendInvite, shareInviteFlight } from './FriendInvite';

const postFriendsBody = vi.hoisted(() => vi.fn());
const identityState = vi.hoisted(() => ({ present: true, revision: 0 }));
vi.mock('../api', () => ({
  postFriendsBody,
  friendsUrl: () => 'https://api.test/friends',
}));
// Accepting an invite is a TRIGGER (#216): the clicker is a brand-new visitor, and their
// identity is minted on this first need so the edge lands before their first game.
vi.mock('../identity', () => ({
  deviceIdentity: () =>
    identityState.present
      ? {
          token: 'f'.repeat(64),
          accountId: 'lfd5pqz5pa7zjm5u',
          deviceId: 'd'.repeat(16),
        }
      : null,
  ensureDeviceIdentity: async () => ({
    token: 'f'.repeat(64),
    accountId: 'lfd5pqz5pa7zjm5u',
    deviceId: 'd'.repeat(16),
  }),
  identityEpoch: () => `lfd5pqz5pa7zjm5u:${'d'.repeat(16)}`,
  identityEpochOf: (value: { accountId: string; deviceId: string }) =>
    `${value.accountId}:${value.deviceId}`,
  identityScopeRevision: () => identityState.revision,
  markDeviceSignedOut: vi.fn(),
}));

const INVITER = 'zwjxqk37xfkvtxqu';

describe('shareInviteFlight — one conversation per invite', () => {
  it('shares pending work across mounts and releases it after settlement', async () => {
    const resolves: Array<(value: 'settled' | 'failed') => void> = [];
    const start = vi.fn(
      () =>
        new Promise<'settled' | 'failed'>((resolve) => {
          resolves.push(resolve);
        }),
    );

    const first = shareInviteFlight(INVITER, start);
    const replay = shareInviteFlight(INVITER, start);
    expect(replay).toBe(first);
    expect(start).toHaveBeenCalledTimes(1);

    resolves[0]('settled');
    await first;

    // Settled work is dropped, so RETRY is a fresh attempt rather than the old answer.
    const retry = shareInviteFlight(INVITER, start);
    expect(retry).not.toBe(first);
    expect(start).toHaveBeenCalledTimes(2);
    resolves[1]('settled');
    await retry;
  });

  it('turns a thrown request into the retryable failure', async () => {
    const start = vi
      .fn<() => Promise<'settled' | 'failed'>>()
      .mockRejectedValueOnce(new Error('offline'));
    await expect(shareInviteFlight('qosuq3j3qtvdak2i', start)).resolves.toBe('failed');
  });

  it('shares the act that bootstraps a replacement identity with its remount', async () => {
    let resolve!: (value: 'settled') => void;
    const start = vi.fn(
      () =>
        new Promise<'settled'>((done) => {
          resolve = done;
        }),
    );
    identityState.present = false;
    identityState.revision = 1; // A has left; this landing is creating B.
    const beforeBootstrap = shareInviteFlight(INVITER, start);

    identityState.present = true;
    identityState.revision = 2; // B arrived and App remounted the landing.
    const afterBootstrap = shareInviteFlight(INVITER, start);
    expect(afterBootstrap).toBe(beforeBootstrap);
    expect(start).toHaveBeenCalledTimes(1);

    resolve('settled');
    await beforeBootstrap;
    identityState.present = true;
    identityState.revision = 0;
  });
});

describe('sendInvite — the click carries the CLICKER key and the SENDER id', () => {
  const answer = async (status: number) => {
    postFriendsBody.mockResolvedValueOnce({ ok: status < 400, status });
    return sendInvite(INVITER);
  };

  it('records the mutual edge with this device\'s token, and a 2xx is the confirmable ADD', async () => {
    await expect(answer(200)).resolves.toBe('added');
    expect(postFriendsBody).toHaveBeenCalledWith('https://api.test/friends', {
      token: 'f'.repeat(64),
      add: INVITER,
    });
  });

  it('treats a refusal as settled — opening your own link is not something to retry', async () => {
    // 400 self_link, 404-ish bad id: the answer will not change by asking again, and the
    // player came here to play. Nothing was added, so nothing is announced.
    await expect(answer(400)).resolves.toBe('settled');
    await expect(answer(404)).resolves.toBe('settled');
  });

  it('tells the player when the cap refused the link, instead of continuing silently', async () => {
    // 409 friend_limit is a verdict too — retrying cannot empty a full list — but it is the
    // one a player could act on, so it neither retries nor vanishes.
    await expect(answer(409)).resolves.toBe('full');
  });

  it('treats the backend failing as retryable', async () => {
    await expect(answer(500)).resolves.toBe('failed');
    await expect(answer(503)).resolves.toBe('failed');
  });
});
