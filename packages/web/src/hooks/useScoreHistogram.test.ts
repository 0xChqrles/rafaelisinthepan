// CONTRACT (#170, narrowed by #203): one finished round starts one POPULATION READ. React
// may unmount the solved screen while that read is pending (archive/tutorial navigation),
// but a new mount must subscribe to the existing work rather than fire a second request.
//
// What #203 retired: the POST, the Turnstile token it carried, the recorded score it
// persisted, and the whole ask-until-recorded machinery around it. The server derives a
// round's score from the guess log it already holds and records the row itself, so this is
// a plain GET — and the round's own score is what locates it in the returned bands, since
// both ends read the same log.

import { describe, expect, it, vi } from 'vitest';
import { readPopulation, shareScoreFlight, type ScorePlacement } from './useScoreHistogram';

vi.mock('../api', () => ({
  scoresUrl: (lang: string, date: string, mode: string) =>
    `https://api.test/scores?lang=${lang}&date=${date}&mode=${mode}`,
  parseScoreHistogram: (data: unknown) => data,
}));

describe('shareScoreFlight — one pending conversation per round', () => {
  it('shares pending work across callers and releases it after settlement', async () => {
    const resolves: Array<(value: ScorePlacement | null) => void> = [];
    const start = vi.fn(
      () =>
        new Promise<ScorePlacement | null>((resolve) => {
          resolves.push(resolve);
        }),
    );

    const first = shareScoreFlight('sentence:fr:1:7', start);
    const remount = shareScoreFlight('sentence:fr:1:7', start);
    expect(remount).toBe(first);
    expect(start).toHaveBeenCalledTimes(1);

    resolves[0](null);
    await first;

    const revisit = shareScoreFlight('sentence:fr:1:7', start);
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

    await expect(shareScoreFlight('word:en:2:3', start)).resolves.toBeNull();
    await expect(shareScoreFlight('word:en:2:3', start)).resolves.toBeNull();
    expect(start).toHaveBeenCalledTimes(2);
  });
});

describe('readPopulation — the day\'s bands, located by this round\'s own score', () => {
  const read = async (
    response: { ok: boolean; json?: () => Promise<unknown> },
    score = 7,
  ) => {
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetchMock);
    try {
      return { placement: await readPopulation('sentence', 'fr', '2026-08-15', score), fetchMock };
    } finally {
      vi.unstubAllGlobals();
    }
  };

  it('READS — never writes — and addresses the day it was asked about', async () => {
    const histogram = { buckets: [{ min: 7, max: 7, count: 1 }], total: 1, bucket: 0 };
    const { placement, fetchMock } = await read({ ok: true, json: async () => histogram });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.test/scores?lang=fr&date=2026-08-15&mode=sentence',
    );
    expect(placement).toEqual({ histogram, bucket: 0 });
  });

  it('locates the round\'s own score in the exact bands', async () => {
    const histogram = {
      buckets: [
        { min: 4, max: 4, count: 1 },
        { min: 7, max: 7, count: 2 },
        { min: 9, max: 9, count: 1 },
      ],
      total: 4,
      // The read carries no identity, so the server names no bucket.
      bucket: null,
    };
    const { placement } = await read({ ok: true, json: async () => histogram });
    expect(placement).toEqual({ histogram, bucket: 1 });
  });

  it('draws NO standing when the population does not hold this round', async () => {
    // Two devices playing one WORD daily: the population holds whichever run submitted
    // first, and this device's count matches no band. Better nothing than a lie.
    const histogram = { buckets: [{ min: 9, max: 9, count: 1 }], total: 1, bucket: null };
    const { placement } = await read({ ok: true, json: async () => histogram });
    expect(placement).toEqual({ histogram, bucket: null });
  });

  it('is silent on every failure — the slot simply shows nothing', async () => {
    for (const status of [404, 429, 500, 503]) {
      const { placement } = await read({ ok: false, json: async () => ({ status }) });
      expect(placement).toBeNull();
    }
  });
});
