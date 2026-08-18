// CONTRACT (#170): one finished round starts one score conversation. React may unmount
// the solved screen while that conversation is pending (archive/tutorial navigation),
// but a new mount must subscribe to the existing work rather than POST the score again.
// And a round spends its ONE submission only on a server VERDICT — never on the server
// simply failing, which would lose the score on a visit the player cannot repeat.

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

describe('syncScore — the round spends its one submission on a verdict only', () => {
  const submit = async (status: number, body: unknown = null) => {
    const markSubmitted = vi.fn();
    postScoreBody.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
    const placement = await syncScore(false, markSubmitted, 'sentence', 'fr', '2026-08-15', 7);
    return { markSubmitted, placement };
  };

  it('marks the round submitted when the server accepts the score', async () => {
    const histogram = { buckets: [{ min: 1, max: 3, count: 1 }], total: 1, bucket: 0 };
    const { markSubmitted, placement } = await submit(200, histogram);
    expect(markSubmitted).toHaveBeenCalledOnce();
    expect(placement).toEqual({ histogram, bucket: 0 });
  });

  it('authenticates the POST with the player key (#187) beside the score and token', async () => {
    await submit(200, { buckets: [], total: 0, bucket: null });
    expect(postScoreBody).toHaveBeenLastCalledWith('https://api.test/scores', {
      secret: '00112233445566778899aabbccddeeff',
      score: 7,
      turnstileToken: 'token',
    });
  });

  it('marks it submitted when the server REFUSES it — a refusal is an answer', async () => {
    // An impossible score, a spent Turnstile token, the sixth submission of the day: the
    // server has ruled, and asking again on every revisit would only be noise.
    for (const status of [400, 403, 429]) {
      const { markSubmitted, placement } = await submit(status);
      expect(markSubmitted).toHaveBeenCalledOnce();
      expect(placement).toBeNull();
    }
  });

  it('leaves it unset when the server FAILS — a 5xx must stay retryable', async () => {
    // The failure this guards against is not hypothetical: a cold-start secret read, a
    // throttled write, or a CDN 502 would otherwise burn the round's only submission and
    // drop that score from the day's population for good.
    for (const status of [500, 502, 503]) {
      const { markSubmitted, placement } = await submit(status);
      expect(markSubmitted).not.toHaveBeenCalled();
      expect(placement).toBeNull();
    }
  });
});
