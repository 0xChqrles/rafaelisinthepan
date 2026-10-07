// CONTRACT (#207): the purge worker stops STARTING jobs well inside its own time limit, logs
// counts only, and throws when a job FAILED — so the Lambda's Errors alarm sees it — but not
// for a queue longer than one run.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PurgeRun } from './purge';

async function workerWith(run: PurgeRun) {
  vi.resetModules();
  const runPurges = vi.fn(async (_deps: unknown, _options: { deadlineMs: number }) => run);
  vi.doMock('./config', () => ({ loadPurgeConfig: () => ({ scoreTable: 'scores' }) }));
  vi.doMock('./purge', () => ({ runPurges }));
  const { handler, PURGE_DEADLINE_MARGIN_MS } = await import('./purgeWorker');
  return { handler, runPurges, margin: PURGE_DEADLINE_MARGIN_MS };
}

afterEach(() => {
  vi.doUnmock('./config');
  vi.doUnmock('./purge');
  vi.restoreAllMocks();
});

describe('purge worker (#207)', () => {
  it('sets the deadline inside the Lambda\'s remaining time and logs counts only', async () => {
    const { handler, runPurges, margin } = await workerWith({ jobs: 3, done: 2, left: 1, failed: 0 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const before = Date.now();
    await expect(
      handler({}, { getRemainingTimeInMillis: () => 300_000 }),
    ).resolves.toEqual({ jobs: 3, done: 2, left: 1, failed: 0 });
    const { deadlineMs } = runPurges.mock.calls[0][1];
    expect(deadlineMs).toBeGreaterThanOrEqual(before + 300_000 - margin);
    expect(deadlineMs).toBeLessThanOrEqual(Date.now() + 300_000 - margin);
    expect(log).toHaveBeenCalledWith('[purge] 3 job(s): 2 done, 1 left, 0 failed');
  });

  it('THROWS when a job failed, so the Errors alarm sees it', async () => {
    const { handler } = await workerWith({ jobs: 2, done: 1, left: 0, failed: 1 });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(handler({}, { getRemainingTimeInMillis: () => 300_000 })).rejects.toThrow();
  });
});
