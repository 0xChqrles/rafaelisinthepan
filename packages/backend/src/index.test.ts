import { describe, expect, it, vi } from 'vitest';
import type { FnUrlEvent } from './respond';

describe('production handler initialization', () => {
  it('retries after an SSM failure and caches the successful handler', async () => {
    vi.resetModules();

    const loadScoreSecrets = vi
      .fn()
      .mockRejectedValueOnce(new Error('SSM temporarily unavailable'))
      .mockResolvedValueOnce({
        turnstileSecret: 'turnstile-value',
        ipHmacSecret: 'h'.repeat(32),
      });
    const initializedHandler = vi.fn(async () => ({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    }));
    const createHandler = vi.fn(() => initializedHandler);

    vi.doMock('./config', () => ({
      loadConfig: () => ({
        bucket: 'puzzles',
        scoreTable: 'scores',
        turnstileSecretParameter: '/whippin/turnstile-secret',
        ipHmacSecretParameter: '/whippin/ip-hmac-secret',
        allowedOrigin: 'https://whippin.ai',
      }),
      loadScoreSecrets,
    }));
    vi.doMock('./handler', () => ({ createHandler }));

    const { handler } = await import('./index');
    const event = {} as FnUrlEvent;

    expect(loadScoreSecrets).not.toHaveBeenCalled();
    await expect(handler(event)).rejects.toThrow('SSM temporarily unavailable');
    await expect(handler(event)).resolves.toMatchObject({ statusCode: 200 });
    await expect(handler(event)).resolves.toMatchObject({ statusCode: 200 });

    expect(loadScoreSecrets).toHaveBeenCalledTimes(2);
    expect(createHandler).toHaveBeenCalledTimes(1);
    expect(initializedHandler).toHaveBeenCalledTimes(2);
  });
});
