// CONTRACT: the share-card routes (issue #8) resolve on the TOKEN alone — before the puzzle
// logic — so they never hit the "lang required" guard. /og/<token>.png returns a PNG,
// /s/<token> returns OG HTML pointing at that image, and a bad token 404s.
import { describe, it, expect } from 'vitest';
import { encodeResult } from '@whippin/shared';
import { createHandler } from './handler';
import type { FnUrlEvent } from './respond';
import type { PuzzleStore } from './store';

// The card routes never touch the store; stub it so nothing else is exercised.
const store: PuzzleStore = { getPuzzle: async () => null, version: async () => null };
const handler = createHandler({ store });

const get = (rawPath: string, headers: Record<string, string> = {}): FnUrlEvent => ({
  rawPath,
  requestContext: { http: { method: 'GET' } },
  headers,
});

// A real dayNumber (days since 1970) and a score whose squareCount matches the 9 squares.
const token = encodeResult({
  lang: 'fr',
  dayNumber: 20638,
  score: 42,
  squares: [8, 20, 35, 50, 65, 78, 90, 100, 100],
});

describe('GET /og/<token>.png', () => {
  it('returns a base64 PNG (real image bytes), cached immutable', async () => {
    const res = await handler(get(`/og/${token}.png`));
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/png');
    expect(res.isBase64Encoded).toBe(true);
    const bytes = Buffer.from(res.body, 'base64');
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); // PNG magic
    expect(res.headers['Cache-Control']).toContain('immutable');
  });

  it('404s an invalid token instead of rendering', async () => {
    const res = await handler(get('/og/not-a-real-token.png'));
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /s/<token>', () => {
  it('returns OG HTML pointing at /og/<token>.png with the score + day', async () => {
    const res = await handler(get(`/s/${token}`, { host: 'whippin.ai', 'x-forwarded-proto': 'https' }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/html');
    expect(res.body).toContain(`content="https://whippin.ai/og/${token}.png"`);
    expect(res.body).toContain('SCORE 42');
    expect(res.body).toContain('#20638');
    expect(res.body).toContain('https://whippin.ai/fr'); // redirect into the game (lang from token)
  });

  it('404s a token-shaped but undecodable value', async () => {
    const res = await handler(get('/s/AAAA')); // valid base64url chars, too short to decode
    expect(res.statusCode).toBe(404);
  });
});
