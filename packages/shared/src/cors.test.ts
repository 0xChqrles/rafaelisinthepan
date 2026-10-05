// CONTRACT: the CORS answer the handler and the CDN's edge preflight both give (cors.ts).
import { describe, expect, it } from 'vitest';
import { PREFLIGHT_MAX_AGE_SECONDS, corsHeaders, preflightHeaders } from './cors';

describe('CORS headers', () => {
  it('permits the payload hash required by CloudFront OAC for live POSTs', () => {
    expect(corsHeaders('https://whippin.ai')['Access-Control-Allow-Headers']).toContain(
      'X-Amz-Content-Sha256',
    );
  });

  it('echoes the configured origin and keeps a cache honest about it', () => {
    const headers = corsHeaders('https://whippin.ai');
    expect(headers['Access-Control-Allow-Origin']).toBe('https://whippin.ai');
    expect(headers.Vary).toBe('Origin');
  });
});

describe('the preflight answer', () => {
  it('is the CORS headers plus how long to keep them, and nothing that forbids keeping it', () => {
    const headers = preflightHeaders('https://whippin.ai');
    expect(headers).toEqual({
      ...corsHeaders('https://whippin.ai'),
      'Access-Control-Max-Age': PREFLIGHT_MAX_AGE_SECONDS,
    });
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain('cache-control');
  });
});
