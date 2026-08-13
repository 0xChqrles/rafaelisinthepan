import { describe, expect, it } from 'vitest';
import { turnstileVerifier } from './turnstile';

describe('turnstileVerifier', () => {
  it('makes one URL-encoded Siteverify call with secret, token and remote IP', async () => {
    const calls: [string | URL | Request, RequestInit | undefined][] = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push([input, init]);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };
    const verifier = turnstileVerifier('server-secret', fetcher);

    await expect(verifier.verify('one-use-token', '198.51.100.10')).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0];
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
    const body = init?.body as URLSearchParams;
    expect(Object.fromEntries(body)).toEqual({
      secret: 'server-secret',
      response: 'one-use-token',
      remoteip: '198.51.100.10',
    });
  });

  it('rejects a Siteverify success:false response', async () => {
    const fetcher: typeof fetch = async () =>
      new Response(JSON.stringify({ success: false }), { status: 200 });
    await expect(turnstileVerifier('secret', fetcher).verify('bad', '203.0.113.1'))
      .resolves.toBe(false);
  });

  it('surfaces an unavailable Siteverify service as an operational error', async () => {
    const fetcher: typeof fetch = async () => new Response('unavailable', { status: 503 });
    await expect(turnstileVerifier('secret', fetcher).verify('token', '203.0.113.1'))
      .rejects.toThrow(/HTTP 503/);
  });
});
