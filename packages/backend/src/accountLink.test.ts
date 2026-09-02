import { describe, expect, it } from 'vitest';
import { mergeFriends } from './accountLink';
import { FRIENDS_MAX } from './friendStore';
import { memoryFriendStore } from './memoryFriendStore';

const FROM = 'aaaaaaaaaaaaaaaa';
const TO = 'bbbbbbbbbbbbbbbb';
const NOW = new Date('2026-08-26T12:00:00.000Z');

describe('friend merge capacity', () => {
  it('reuses the slot freed by the source/destination friendship', async () => {
    const friends = memoryFriendStore();
    const at = '2026-08-01T00:00:00.000Z';
    await friends.link({ publicId: FROM, friendId: TO, createdAt: at });
    for (let index = 0; index < FRIENDS_MAX - 1; index += 1) {
      await friends.link({
        publicId: TO,
        friendId: `held-${String(index).padStart(16, '0')}`,
        createdAt: at,
      });
    }
    const candidate = 'cccccccccccccccc';
    await friends.link({ publicId: FROM, friendId: candidate, createdAt: at });

    await mergeFriends(friends, FROM, TO);

    const held = await friends.list(TO);
    expect(held).toHaveLength(FRIENDS_MAX);
    expect(held).toContain(candidate);
    expect(held).not.toContain(FROM);
    await expect(friends.list(candidate)).resolves.toEqual([TO]);
  });
});

describe('friend merge against a graph that moved since the plan', () => {
  it('does not resurrect a friendship either side ended between the plan and the write', async () => {
    const FRIEND = 'cccccccccccccccc';
    const friends = memoryFriendStore();
    await friends.link({ publicId: FROM, friendId: FRIEND, createdAt: NOW.toISOString() });
    // The plan was read while the edge stood…
    const plan = [{ friendId: FRIEND, keep: true, createdAt: NOW.toISOString() }];
    // …and the friend unlinked before the batch was written.
    await friends.unlink(FRIEND, FROM);
    await friends.transfer(FROM, TO, plan);

    await expect(friends.list(TO)).resolves.toEqual([]);
    await expect(friends.list(FRIEND)).resolves.toEqual([]);
    // Nothing points at the account being deleted either way.
    await expect(friends.list(FROM)).resolves.toEqual([]);
  });
});
