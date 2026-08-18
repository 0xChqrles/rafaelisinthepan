import { describe, expect, it } from 'vitest';
import { memoryScoreStore } from './memoryScoreStore';
import { SCORE_SUBMISSION_LIMIT, type ScoreKey, type ScoreSubmission } from './scoreStore';

const KEY: ScoreKey = { date: '2026-08-13', lang: 'fr', mode: 'sentence' };

function submission(overrides: Partial<ScoreSubmission> = {}): ScoreSubmission {
  return {
    ...KEY,
    publicId: 'player-a',
    score: 7,
    submittedAt: '2026-08-13T14:00:00.000Z',
    ipHash: 'hash-a',
    expiresAt: 200_000,
    requestToken: 'request-0',
    ...overrides,
  };
}

describe('memoryScoreStore — local mirror of storage semantics (#187)', () => {
  it('records one first-write-wins row per player, replaying one request idempotently', async () => {
    const store = memoryScoreStore(() => new Date(100_000_000));
    expect(await store.submit(submission())).toBe('recorded');
    // The identical request (an internal retry) reports success without writing twice.
    expect(await store.submit(submission())).toBe('recorded');
    // A NEW submission from the same player is refused: the first write won.
    expect(await store.submit(submission({ score: 3, requestToken: 'request-1' }))).toBe(
      'already_recorded',
    );
    expect(await store.list(KEY)).toEqual([{ publicId: 'player-a', score: 7 }]);
  });

  it('a refused duplicate consumes no IP allowance', async () => {
    const store = memoryScoreStore(() => new Date(100_000_000));
    await store.submit(submission());
    for (let index = 0; index < 3; index += 1) {
      await store.submit(submission({ score: 1, requestToken: `dup-${index}` }));
    }
    // One recorded + three duplicates: the allowance holds four more fresh players.
    for (let index = 0; index < SCORE_SUBMISSION_LIMIT - 1; index += 1) {
      expect(
        await store.submit(
          submission({ publicId: `player-${index}`, requestToken: `fresh-${index}` }),
        ),
      ).toBe('recorded');
    }
    expect(
      await store.submit(submission({ publicId: 'player-over', requestToken: 'over-cap' })),
    ).toBe('capped');
  });

  it('allows five players per daily/IP, then atomically rejects without writing', async () => {
    const store = memoryScoreStore(() => new Date(100_000_000));
    for (let index = 0; index < SCORE_SUBMISSION_LIMIT; index += 1) {
      expect(
        await store.submit(
          submission({ publicId: `player-${index}`, requestToken: `request-${index}` }),
        ),
      ).toBe('recorded');
    }
    expect(
      await store.submit(submission({ publicId: 'player-over', requestToken: 'request-over' })),
    ).toBe('capped');
    expect((await store.list(KEY)).length).toBe(SCORE_SUBMISSION_LIMIT);
  });

  it('isolates rows and the cap by date, language, mode and HMAC hash', async () => {
    const store = memoryScoreStore(() => new Date(100_000_000));
    for (let index = 0; index < SCORE_SUBMISSION_LIMIT; index += 1) {
      await store.submit(
        submission({ publicId: `player-${index}`, requestToken: `base-${index}` }),
      );
    }
    expect(
      await store.submit(
        submission({ publicId: 'other-ip', ipHash: 'hash-b', requestToken: 'other-ip' }),
      ),
    ).toBe('recorded');
    expect(
      await store.submit(
        submission({ publicId: 'player-0', mode: 'word', score: 2, requestToken: 'other-mode' }),
      ),
    ).toBe('recorded');
    expect((await store.list(KEY)).length).toBe(SCORE_SUBMISSION_LIMIT + 1);
    expect(await store.list({ ...KEY, mode: 'word' })).toEqual([
      { publicId: 'player-0', score: 2 },
    ]);
  });

  it('starts a fresh allowance after the 48h dedup item expires', async () => {
    let now = new Date(100_000_000);
    const store = memoryScoreStore(() => now);
    for (let index = 0; index < SCORE_SUBMISSION_LIMIT; index += 1) {
      await store.submit(
        submission({ publicId: `old-${index}`, expiresAt: 101_000, requestToken: `old-${index}` }),
      );
    }
    now = new Date(102_000_000);
    expect(
      await store.submit(
        submission({ publicId: 'fresh', expiresAt: 300_000, requestToken: 'fresh' }),
      ),
    ).toBe('recorded');
    expect((await store.list(KEY)).length).toBe(SCORE_SUBMISSION_LIMIT + 1);
  });
});
