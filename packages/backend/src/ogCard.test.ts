// CONTRACT: the share-card routes (issue #8) resolve on the TOKEN alone — before the puzzle
// logic — so they never hit the "lang required" guard. /og/<token>.png returns a PNG,
// /s/<token> returns OG HTML pointing at that image, and a bad token 404s.
import { describe, it, expect } from 'vitest';
import { encodeResult, dateForDayNumber } from '@whippin/shared';
import { createHandler } from './handler';
import type { FnUrlEvent } from './respond';
import type { PuzzleStore } from './store';

// The card routes never touch the store; stub it so nothing else is exercised.
const store: PuzzleStore = { getPuzzle: async () => null };
const handler = createHandler({ store });

const get = (rawPath: string, headers: Record<string, string> = {}): FnUrlEvent => ({
  rawPath,
  requestContext: { http: { method: 'GET' } },
  headers,
});

// A real dayNumber (days since 1970) and a run whose length matches the score, with the
// three secrets dropped on tries 4, 9 and 12 (the v2 token's ruler payload).
const run = {
  score: 12,
  trajectory: [0, 0, 18, 41, 41, 41, 55, 55, 72, 72, 72, 100],
  solvedAt: [4, 12, 9],
};
const token = encodeResult({ lang: 'fr', dayNumber: 20638, ...run });
const enToken = encodeResult({ lang: 'en', dayNumber: 20638, ...run });

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
  it('localizes the OG HTML by the token language (fr): unit, <html lang>, body link', async () => {
    const res = await handler(get(`/s/${token}`, { host: 'whippin.ai', 'x-forwarded-proto': 'https' }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/html');
    expect(res.body).toContain(`content="https://whippin.ai/og/${token}.png"`);
    expect(res.body).toContain('12 essais'); // fr unit named — lower is better
    // The day is titled by its calendar date, like the card draws and the link resolves to.
    expect(res.body).toContain(`Whippin AI ${dateForDayNumber(20638)} — 12 essais`);
    expect(res.body).not.toContain('#20638');
    expect(res.body).toContain('<html lang="fr">');
    expect(res.body).toContain('Jouer à Whippin AI'); // no-JS body link (fr)
    // Redirect into the game AT THE SHARED DAY (date-addressed, #55), not bare /fr.
    expect(res.body).toContain(`https://whippin.ai/fr/${dateForDayNumber(20638)}`);
  });

  it('keeps English for an en token: try/tries, <html lang="en">, English link', async () => {
    const res = await handler(get(`/s/${enToken}`, { host: 'whippin.ai', 'x-forwarded-proto': 'https' }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('12 tries');
    expect(res.body).toContain('<html lang="en">');
    expect(res.body).toContain('Play Whippin AI');
    expect(res.body).toContain(`https://whippin.ai/en/${dateForDayNumber(20638)}`);
  });

  it('click-through targets the SHARED archive day, not today (#55)', async () => {
    // A past day distinct from any "today": both the JS redirect and the no-JS body link
    // must point at /<lang>/<that date>, never the bare /<lang> (which would be today).
    const day = 20500;
    const date = dateForDayNumber(day); // e.g. 2026-02-...
    const tok = encodeResult({ lang: 'en', dayNumber: day, ...run });
    const res = await handler(get(`/s/${tok}`, { host: 'whippin.ai', 'x-forwarded-proto': 'https' }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`location.replace("https://whippin.ai/en/${date}")`); // JS redirect
    expect(res.body).toContain(`href="https://whippin.ai/en/${date}"`); // no-JS fallback link
    expect(res.body).not.toContain('"https://whippin.ai/en"'); // never bare (today)
  });

  it('404s a token-shaped but undecodable value', async () => {
    const res = await handler(get('/s/AAAA')); // valid base64url chars, too short to decode
    expect(res.statusCode).toBe(404);
  });

  // A link shared before the v2 bump can't draw its card, but it still names a real day.
  // Sending its reader there beats a dead end; a FORGED current-version token must not
  // earn the same courtesy.
  it('redirects a superseded (v1) token to the day it named instead of 404ing', async () => {
    // v1 header: version 1 | lang 1 (fr) | day 638 | scoreLen 0, then a squares payload.
    const v1 = 'FBPwAAA';
    const res = await handler(get(`/s/${v1}`, { host: 'whippin.ai', 'x-forwarded-proto': 'https' }));
    expect(res.statusCode).toBe(301);
    expect(res.headers.Location).toBe(`https://whippin.ai/fr/${dateForDayNumber(20638)}`);
  });

  it('still 404s a corrupted CURRENT-version token (no redirect for a forgery)', async () => {
    const res = await handler(get(`/s/${token.slice(0, 4)}`));
    expect(res.statusCode).toBe(404);
  });
});
