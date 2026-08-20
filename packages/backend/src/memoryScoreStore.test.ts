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

  it('reads a KNOWN key set, the friends board way (#190) — the Dynamo twin', async () => {
    const store = memoryScoreStore(() => new Date(100_000_000));
    await store.submit(submission());
    await store.submit(submission({ publicId: 'player-b', score: 3, ipHash: 'hash-b', requestToken: 'r-b' }));
    await store.submit(submission({ publicId: 'player-c', score: 9, ipHash: 'hash-c', requestToken: 'r-c' }));

    // Only what was asked for, duplicates collapsed, and a player with no row today
    // simply has none — the friends board's `waiting` list is built from that absence.
    expect(await store.getMany(KEY, ['player-c', 'player-a', 'player-c', 'never-played'])).toEqual([
      { publicId: 'player-c', score: 9 },
      { publicId: 'player-a', score: 7 },
    ]);
    expect(await store.getMany(KEY, [])).toEqual([]);
    // A different daily's partition is a different population.
    expect(await store.getMany({ ...KEY, mode: 'word' }, ['player-a'])).toEqual([]);
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

  // The allowance is a PARAMETER because the local server turns it off (serve.ts): every
  // client there shares one address, so the cap bounds nothing and instead silences the
  // daily loop after five identities. The DEFAULT stays the shared production rule.
  it('honours an overridden allowance — what backend:dev opts out with', async () => {
    const store = memoryScoreStore(() => new Date(100_000_000), Number.POSITIVE_INFINITY);
    // Well past the shared cap, every one of them from the SAME address hash — which is
    // what one developer's machine looks like to this store.
    for (let index = 0; index < SCORE_SUBMISSION_LIMIT + 3; index += 1) {
      expect(
        await store.submit(
          submission({ publicId: `player-${index}`, requestToken: `request-${index}` }),
        ),
      ).toBe('recorded');
    }
    expect((await store.list(KEY)).length).toBe(SCORE_SUBMISSION_LIMIT + 3);
  });
});
