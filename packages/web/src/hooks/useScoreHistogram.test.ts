// CONTRACT (#170): one finished round starts one score conversation. React may unmount
// the solved screen while that conversation is pending (archive/tutorial navigation),
// but a new mount must subscribe to the existing work rather than POST the score again.

import { describe, expect, it, vi } from 'vitest';
import { shareScoreFlight, type ScorePlacement } from './useScoreHistogram';

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
