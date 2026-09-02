import { describe, expect, it } from 'vitest';
import { dayNumber } from '@whippin/shared';
import { mergeFriends, supportedTuples, transferActiveDay } from './accountLink';
import { FRIENDS_MAX } from './friendStore';
import { memoryFriendStore } from './memoryFriendStore';
import { memoryHistoryStore } from './memoryHistoryStore';
import { memoryRoundStore } from './memoryRoundStore';
import { memoryScoreStore } from './memoryScoreStore';
import type { ScoreStore } from './scoreStore';

const FROM = 'aaaaaaaaaaaaaaaa';
const TO = 'bbbbbbbbbbbbbbbb';
const DATE = '2026-08-26';
const NOW = new Date(`${DATE}T12:00:00.000Z`);

describe('active-day account transfer recovery', () => {
  it('finishes score and solved-day work after the round already moved on a failed attempt', async () => {
    const rounds = memoryRoundStore();
    const scores = memoryScoreStore(() => NOW);
    const history = memoryHistoryStore();
    const tuple = supportedTuples().find(({ mode }) => mode === 'sentence')!;
    const key = { date: DATE, ...tuple };
    await rounds.append({
      ...key,
      publicId: FROM,
      guesses: ['chat', 'chien'],
      puzzle: 'rev1',
      progress: 100,
      solved: true,
      now: NOW,
    });
    await scores.submit({
      ...key,
      publicId: FROM,
      score: 2,
      submittedAt: NOW.toISOString(),
      revision: 'rev1',
      ipHash: 'ip',
      expiresAt: 0,
      requestToken: 'request',
    });

    let fail = true;
    const flakyScores: ScoreStore = {
      ...scores,
      async transfer(move, from, to) {
        if (fail) {
          fail = false;
          throw new Error('score transfer unavailable');
        }
        return scores.transfer(move, from, to);
      },
    };

    await expect(
      transferActiveDay({ rounds, scores: flakyScores, history }, FROM, TO, DATE),
    ).rejects.toThrow(/score transfer/);
    await expect(rounds.get(key, FROM, 'rev1')).resolves.toBeNull();

    // The retry recognizes the destination round as the earlier move and resumes the
    // idempotent operations that follow it instead of skipping the tuple.
    await expect(
      transferActiveDay({ rounds, scores: flakyScores, history }, FROM, TO, DATE),
    ).resolves.toEqual([]);
    await expect(scores.list(key)).resolves.toEqual([{ publicId: TO, score: 2 }]);
    await expect(history.solvedDays(TO, tuple.lang)).resolves.toEqual([dayNumber(DATE)]);
  });
});

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
