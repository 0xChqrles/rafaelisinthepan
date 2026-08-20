// CONTRACT (#170): one finished round starts one score conversation. React may unmount
// the solved screen while that conversation is pending (archive/tutorial navigation),
// but a new mount must subscribe to the existing work rather than POST the score again.
// And a round is settled by the POPULATION, not by the conversation: only an answer that
// RECORDS the score stops it asking, so a refusal and a failure alike stay retryable on
// the next visit rather than losing that score on a visit the player cannot repeat.

import { describe, expect, it, vi } from 'vitest';
import { shareScoreFlight, syncScore, type ScorePlacement } from './useScoreHistogram';

const postScoreBody = vi.hoisted(() => vi.fn());
vi.mock('../api', () => ({
  postScoreBody,
  scoresUrl: () => 'https://api.test/scores',
  parseScoreHistogram: (data: unknown) => data,
}));
vi.mock('../turnstile', () => ({ turnstileToken: async () => 'token' }));
vi.mock('../identity', () => ({ playerSecret: () => '00112233445566778899aabbccddeeff' }));

describe('shareScoreFlight — one pending conversation per round', () => {
  it('shares pending work across callers and releases it after settlement', async () => {
    const resolves: Array<(value: ScorePlacement | null) => void> = [];
    const start = vi.fn(
      () =>
        new Promise<ScorePlacement | null>((resolve) => {
          resolves.push(resolve);
        }),
    );

    const first = shareScoreFlight('post:sentence:fr:1:7', start);
    const remount = shareScoreFlight('post:sentence:fr:1:7', start);
    expect(remount).toBe(first);
    expect(start).toHaveBeenCalledTimes(1);

    resolves[0](null);
    await first;

    const revisit = shareScoreFlight('post:sentence:fr:1:7', start);
    expect(revisit).not.toBe(first);
    expect(start).toHaveBeenCalledTimes(2);
    resolves[1](null);
    await revisit;
  });

  it('releases a failed conversation so a later visit may retry', async () => {
    const start = vi
      .fn<() => Promise<ScorePlacement | null>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(null);

    await expect(shareScoreFlight('post:word:en:2:3', start)).resolves.toBeNull();
    await expect(shareScoreFlight('post:word:en:2:3', start)).resolves.toBeNull();
    expect(start).toHaveBeenCalledTimes(2);
  });
});

describe('syncScore — a round asks until the population HOLDS its score', () => {
  const submit = async (status: number, body: unknown = null) => {
    const markRecorded = vi.fn();
    postScoreBody.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
    const placement = await syncScore(markRecorded, 'sentence', 'fr', '2026-08-15', 7);
    return { markRecorded, placement };
  };

  it('records the score when the server accepts it', async () => {
    const histogram = { buckets: [{ min: 7, max: 7, count: 1 }], total: 1, bucket: 0 };
    const { markRecorded, placement } = await submit(200, histogram);
    expect(markRecorded).toHaveBeenCalledOnce();
    expect(markRecorded).toHaveBeenCalledWith(7);
    expect(placement).toEqual({ histogram, bucket: 0 });
  });

  it('persists the STORED row\'s score when first-write-wins answered a duplicate (#187)', async () => {
    // Another device already recorded 9 under this key; this device finished at 7. The
    // server answers with the stored band, and THAT score — never the local 7 — is what
    // revisit GETs must locate with, or the standing changes between the POST and the
    // next reload.
    const histogram = {
      buckets: [
        { min: 4, max: 4, count: 1 },
        { min: 9, max: 9, count: 1 },
      ],
      total: 2,
      bucket: 1,
    };
    const { markRecorded, placement } = await submit(200, histogram);
    expect(markRecorded).toHaveBeenCalledWith(9);
    expect(placement).toEqual({ histogram, bucket: 1 });
  });

  it('authenticates the POST with the player key (#187) beside the score and token', async () => {
    await submit(200, { buckets: [], total: 0, bucket: null });
    expect(postScoreBody).toHaveBeenLastCalledWith('https://api.test/scores', {
      secret: '00112233445566778899aabbccddeeff',
      score: 7,
      turnstileToken: 'token',
    });
  });

  it('records NOTHING when the server REFUSES it — a 4xx leaves the round retryable', async () => {
    // The refusal that matters is the 403: Turnstile refusing the REQUEST, never the
    // server judging the SCORE. Persisting a "submitted" flag here dropped that score
    // from the day's population for good, silently, on a visit the player cannot repeat —
    // and the round could not tell that refusal apart from an honest one afterwards.
    for (const status of [400, 403, 404, 429]) {
      const { markRecorded, placement } = await submit(status);
      expect(markRecorded).not.toHaveBeenCalled();
      expect(placement).toBeNull();
    }
  });

  it('locates the revisit GET by the recorded score, never the local count (#187)', async () => {
    const histogram = {
      buckets: [
        { min: 4, max: 4, count: 1 },
        { min: 9, max: 9, count: 1 },
      ],
      total: 2,
      bucket: null,
    };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => histogram }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const markRecorded = vi.fn();
      // Local count 7, but the population recorded 9 for this round on another device.
      const placement = await syncScore(markRecorded, 'sentence', 'fr', '2026-08-15', 7, 9);
      expect(placement).toEqual({ histogram, bucket: 1 });
      expect(markRecorded).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('RE-SUBMITS a round the population does not hold, rather than GETting a standing that is not there', async () => {
    // The revisit that finds a round with no recorded score — one a 4xx refused, one a
    // 5xx or a dead Turnstile never got an answer for — POSTs again instead of reading.
    // Safe by construction since #187: the row is first-write-wins, so a duplicate
    // changes nothing server-side and comes back with the STORED band. Falling back to a
    // GET here could only ever locate the LOCAL count, which would place this round in
    // whatever band another player happened to record at that score.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const histogram = { buckets: [{ min: 7, max: 7, count: 1 }], total: 1, bucket: 0 };
      const { markRecorded, placement } = await submit(200, histogram);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(markRecorded).toHaveBeenCalledWith(7);
      expect(placement).toEqual({ histogram, bucket: 0 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('records nothing when the server FAILS — a 5xx must stay retryable', async () => {
    // The failure this guards against is not hypothetical: a cold-start secret read, a
    // throttled write, or a CDN 502 would otherwise drop that score from the day's
    // population for good.
    for (const status of [500, 502, 503]) {
      const { markRecorded, placement } = await submit(status);
      expect(markRecorded).not.toHaveBeenCalled();
      expect(placement).toBeNull();
    }
  });
});
