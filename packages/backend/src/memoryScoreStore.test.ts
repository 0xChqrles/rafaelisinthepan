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
    revision: 'a1b2c3d4e5f60718',
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

// CONTRACT (#203, user-decided 2026-08-22): first write wins PER PUBLISHED VERSION. A
// republish means the puzzle contained an error and the round it retired started over, so
// the score that round earned must not stand in the way of the one the player then actually
// earns — which is what `already_recorded` did, silently, leaving the old number on the day.
describe('first-write-wins is per VERSION (#203)', () => {
  const KEY = { date: '2026-08-13', lang: 'fr', mode: 'sentence' as const };
  // `token` varies independently so the two DIFFERENT things can be told apart: a replay of
  // one request (same token — answered with what it answered before) and a genuinely second
  // submission landing on the same row (different token — the condition decides).
  const submit = (
    store: ReturnType<typeof memoryScoreStore>,
    score: number,
    revision: string,
    token = `token-${revision}`,
  ) =>
    store.submit({
      ...KEY,
      publicId: 'lfd5pqz5pa7zjm5u',
      score,
      submittedAt: '2026-08-13T14:00:00.000Z',
      revision,
      ipHash: 'hash',
      expiresAt: 0,
      requestToken: token,
    });

  it('refuses a repeat on the SAME version and takes the score of a NEW one', async () => {
    const store = memoryScoreStore(() => new Date());
    await expect(submit(store, 2, 'a1b2c3d4e5f60718')).resolves.toBe('recorded');
    await expect(submit(store, 5, 'a1b2c3d4e5f60718', 'other')).resolves.toBe('already_recorded');
    expect(await store.list(KEY)).toEqual([{ publicId: 'lfd5pqz5pa7zjm5u', score: 2 }]);

    // The puzzle is corrected: the round started over, and so does its score.
    await expect(submit(store, 1, 'b2c3d4e5f6071829')).resolves.toBe('recorded');
    expect(await store.list(KEY)).toEqual([{ publicId: 'lfd5pqz5pa7zjm5u', score: 1 }]);
  });

  it('carries the revision INTO the idempotency token, or the corrected write is a "replay"', async () => {
    // The route derives the token from the row key AND the revision. Without the revision
    // the corrected submission looks like a retry of the retired one and is dropped before
    // its condition is ever evaluated — which is exactly how the old score kept the day.
    const store = memoryScoreStore(() => new Date());
    await submit(store, 2, 'a1b2c3d4e5f60718', 'shared');
    await expect(submit(store, 1, 'b2c3d4e5f6071829', 'shared')).resolves.toBe('recorded');
    expect(await store.list(KEY)).toEqual([{ publicId: 'lfd5pqz5pa7zjm5u', score: 2 }]);
  });

  it('keeps ONE row per player — a corrected score replaces, never accumulates', async () => {
    const store = memoryScoreStore(() => new Date());
    await submit(store, 2, 'a1b2c3d4e5f60718');
    await submit(store, 1, 'b2c3d4e5f6071829');
    expect(await store.list(KEY)).toHaveLength(1);
  });

  it('replaces at an exhausted IP allowance without consuming another slot', async () => {
    const store = memoryScoreStore(() => new Date(100_000_000), 1);
    await expect(store.submit(submission({ score: 4, requestToken: 'old' }))).resolves.toBe(
      'recorded',
    );

    // The one allowed population row already exists. A correction changes that row; it
    // does not add a player and therefore must not ask the allowance for a second slot.
    await expect(
      store.submit(
        submission({
          score: 3,
          revision: 'b2c3d4e5f6071829',
          requestToken: 'corrected',
        }),
      ),
    ).resolves.toBe('recorded');
    await expect(
      store.submit(
        submission({
          score: 2,
          revision: 'b2c3d4e5f6071829',
          requestToken: 'same-version',
        }),
      ),
    ).resolves.toBe('already_recorded');
    await expect(
      store.submit(submission({ publicId: 'player-b', requestToken: 'new-player' })),
    ).resolves.toBe('capped');
    expect(await store.list(KEY)).toEqual([{ publicId: 'player-a', score: 3 }]);
  });
});
