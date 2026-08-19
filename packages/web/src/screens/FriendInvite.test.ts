// CONTRACT (#189): one click on an invite link starts ONE conversation, and the click
// continues into the game on every answer the server actually gives. React may replay the
// landing's effect (development StrictMode) or remount it, and neither may mint a second
// request. A 4xx is a verdict the player cannot argue with; only the backend failing is
// worth retrying, and that is the one case this screen says out loud.

import { describe, expect, it, vi } from 'vitest';
import { sendInvite, shareInviteFlight } from './FriendInvite';

const postFriendsBody = vi.hoisted(() => vi.fn());
vi.mock('../api', () => ({
  postFriendsBody,
  friendsUrl: () => 'https://api.test/friends',
}));
vi.mock('../identity', () => ({ playerSecret: () => '00112233445566778899aabbccddeeff' }));

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
});

describe('sendInvite — the click carries the CLICKER key and the SENDER id', () => {
  const answer = async (status: number) => {
    postFriendsBody.mockResolvedValueOnce({ ok: status < 400, status });
    return sendInvite(INVITER);
  };

  it('records the mutual edge with the player key, generated on this first need', async () => {
    await expect(answer(200)).resolves.toBe('settled');
    expect(postFriendsBody).toHaveBeenCalledWith('https://api.test/friends', {
      secret: '00112233445566778899aabbccddeeff',
      add: INVITER,
    });
  });

  it('treats a refusal as settled — opening your own link is not something to retry', async () => {
    // 400 self_link, 409 friend_limit: the answer will not change by asking again, and the
    // player came here to play.
    await expect(answer(400)).resolves.toBe('settled');
    await expect(answer(409)).resolves.toBe('settled');
  });

  it('treats the backend failing as retryable', async () => {
    await expect(answer(500)).resolves.toBe('failed');
    await expect(answer(503)).resolves.toBe('failed');
  });
});
