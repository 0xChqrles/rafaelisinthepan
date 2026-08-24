// CONTRACT (#189, reworked by the #216 triggers, user-decided 2026-08-24): accepting an
// invite is a BUTTON, never a page load — the tap deploys the clicker's identity if they
// have none, records the mutual edge, and never dead-ends. A SUCCESS is confirmed on
// screen before continuing (user feedback 2026-08-20 — 'added'). A non-cap 4xx is a
// verdict the player cannot argue with and continues silently; only the backend failing
// is worth retrying, on the error surface. TWO answers are said out loud as blockers —
// the failure, and the cap, which is a verdict the player CAN act on and would otherwise
// leave a full player clicking invitations forever, each one appearing to work.
// (The old `shareInviteFlight` one-conversation map is GONE with the auto-add: the
// effect-replay hazard it guarded no longer exists once the POST rides a click.)

import { describe, expect, it, vi } from 'vitest';
import { sendInvite } from './FriendInvite';

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
  ensureRequestIdentity: async () => ({
    identity: {
      token: 'f'.repeat(64),
      accountId: 'lfd5pqz5pa7zjm5u',
      deviceId: 'd'.repeat(16),
    },
    epoch: `lfd5pqz5pa7zjm5u:${'d'.repeat(16)}`,
  }),
  identityEpoch: () => `lfd5pqz5pa7zjm5u:${'d'.repeat(16)}`,
  identityEpochOf: (value: { accountId: string; deviceId: string }) =>
    `${value.accountId}:${value.deviceId}`,
  identityScopeRevision: () => identityState.revision,
  markDeviceSignedOut: vi.fn(),
}));

const INVITER = 'zwjxqk37xfkvtxqu';

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
