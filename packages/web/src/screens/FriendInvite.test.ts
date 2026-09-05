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
import { anonName, encodeResult, encodeWordResult } from '@whippin/shared';
import { inviterFrom, isOwnLink, landingAfter, sendInvite, sharedResultFrom } from './FriendInvite';

const postFriendsBody = vi.hoisted(() => vi.fn());
const identityState = vi.hoisted(() => ({ present: true, revision: 0 }));
vi.mock('../api', () => ({
  postFriendsBody,
  friendsUrl: () => 'https://api.test/friends',
  readProfile: vi.fn(),
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

// CONTRACT (#204): an invite link carries the SENDER's account id, and an email link can
// DELETE that account. `GET /profile` says so with a 410 `account_gone`, and this landing
// must act on it BEFORE offering anything: drawing the erased player's assigned face over
// an ADD FRIEND whose only possible outcome is `unknown_player` is the one thing the
// expired state exists to prevent.
describe('inviterFrom — what each profile answer means on the landing', () => {
  it('a DELETED account ends the landing: no face, no button, no request', () => {
    expect(inviterFrom({ status: 'gone' }, INVITER)).toBe('gone');
  });

  it('a stored profile is the inviter, and an EMPTY stored name falls back to the pseudonym', () => {
    expect(
      inviterFrom(
        { status: 'shown', profile: { publicId: INVITER, name: 'Zoe', avatar: null } },
        INVITER,
      ),
    ).toEqual({ name: 'Zoe', avatar: null });
    expect(
      inviterFrom(
        { status: 'shown', profile: { publicId: INVITER, name: '', avatar: null } },
        INVITER,
      ),
    ).toEqual({ name: anonName(INVITER), avatar: null });
  });

  it('a 404 and a FAILED read both keep the assigned identity — neither is a deletion', () => {
    const assigned = { name: anonName(INVITER), avatar: null };
    expect(inviterFrom({ status: 'blank' }, INVITER)).toEqual(assigned);
    expect(inviterFrom({ status: 'failed' }, INVITER)).toEqual(assigned);
  });
});

// A SIGNED share's landing (user-decided 2026-09-05): the token the link carries is the
// share codec's own — read here, shown over the face — and the way onward is the DAY it
// was played, both modes; a plain invite (no token, or one this build cannot read) still
// hands the destination to the home redirect.
describe('sharedResultFrom / landingAfter — the shared result on the landing', () => {
  it('decodes a sentence share and continues into that day', () => {
    const token = encodeResult({
      lang: 'fr',
      dayNumber: 20638,
      score: 3,
      trajectory: [40, 70, 100],
      solvedAt: [1, 2, 3],
    });
    const shared = sharedResultFrom(token);
    expect(shared?.mode).toBe('sentence');
    expect(shared?.result.dayNumber).toBe(20638);
    expect(landingAfter(shared)).toBe('/fr/2026-07-04');
  });

  it('decodes a word share and continues into that day\'s WORD route', () => {
    const token = encodeWordResult({ lang: 'en', dayNumber: 20638, counts: [2, 1, 0, 0, 0], word: 'phare' });
    const shared = sharedResultFrom(token);
    expect(shared?.mode).toBe('word');
    expect(landingAfter(shared)).toBe('/en/word/2026-07-04');
  });

  // The sender's own signed link is the plain share to them: no landing, the day itself.
  it('recognises the device\'s own account as the signer', () => {
    expect(isOwnLink('lfd5pqz5pa7zjm5u')).toBe(true);
    expect(isOwnLink(INVITER)).toBe(false);
    identityState.present = false;
    expect(isOwnLink('lfd5pqz5pa7zjm5u')).toBe(false);
    identityState.present = true;
  });

  it('a missing or unreadable token is a plain invite, home onward', () => {
    expect(sharedResultFrom(undefined)).toBeNull();
    expect(sharedResultFrom('not-a-token')).toBeNull();
    expect(landingAfter(null)).toBe('/');
  });
});
