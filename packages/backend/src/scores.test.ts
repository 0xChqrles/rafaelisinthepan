// CONTRACT (#169/#187, narrowed by #203): /scores is date/lang/mode-addressed and
// READ-ONLY. It serves the histogram DERIVED from the day's per-player rows (one exact
// ascending band per distinct recorded score) for a PUBLISHED daily, and refuses every
// other method.
//
// What #203 retired here: the POST, the client-claimed score it carried, its per-mode range
// validation and its Turnstile gate. The server derives a round's score from the guess log
// it already holds and records the row itself (rounds.test.ts covers that, including the
// HMAC-IP volume cap that moved with the write). What stays is the address plumbing both
// live routes share, and the digest the cap is keyed by.

import { describe, expect, it } from 'vitest';
import { VIEWER_IP_HEADER, type Puzzle, type ScoreHistogram, type WordPuzzle } from '@whippin/shared';
import { createHandler, type HandlerDeps } from './handler';
import { memoryScoreStore } from './memoryScoreStore';
import { WORD_SCORE_ZONE } from './scoreLimits';
import { derivedHistogram, hashClientIp } from './scores';
import { clientIp } from './liveRoute';
import type { FnUrlEvent } from './respond';
import type { PuzzleStore } from './store';

const NOW = new Date('2026-08-13T14:00:00Z');
const ACTIVE_DATE = '2026-08-13';
const NEXT_DATE = '2026-08-14';
const FUTURE_DATE = '2026-08-15';
const ORIGIN = 'https://whippin.example';
const SECRET = '00112233445566778899aabbccddeeff';

const SENTENCE: Puzzle = {
  lang: 'fr',
  words: ['un', 'deux', 'trois'],
  holes: [
    {
      pos: 0,
      secret: { word: 'un', slug: 'un' },
      start: { word: 'autre', slug: 'autre' },
      start_rank: 10,
    },
  ],
  ranks: { un: { un: { word: 'un', rank: 0 }, autre: { word: 'autre', rank: 10 } } },
};

// Only two distinct groups are claimable, despite one alias and an out-of-zone entry.
const WORD: WordPuzzle = {
  lang: 'fr',
  word: { word: 'océan', slug: 'ocean' },
  ranks: {
    ocean: { word: 'océan', rank: 0, freq: 10 },
    mer: { word: 'mer', rank: 1, dq: 255, freq: 20 },
    mers: { word: 'mer', rank: 1, dq: 255, freq: 20 },
    eau: { word: 'eau', rank: 2, dq: 240, freq: 30 },
    loin: { word: 'loin', rank: WORD_SCORE_ZONE + 1, dq: 2, freq: 40 },
  },
};

function puzzleStore(): PuzzleStore {
  return {
    async getPuzzle(date, lang) {
      return [ACTIVE_DATE, NEXT_DATE].includes(date) && lang === 'fr' ? SENTENCE : null;
    },
    async getWordPuzzle(date, lang) {
      return [ACTIVE_DATE, NEXT_DATE].includes(date) && lang === 'fr' ? WORD : null;
    },
    // The read never touches the slice — only the round route derives anything.
    async getSlice() {
      throw new Error('/scores must not read the derivation slice');
    },
  };
}

function makeHandler(overrides: Partial<HandlerDeps> = {}) {
  return createHandler({
    store: puzzleStore(),
    now: () => NOW,
    allowedOrigin: ORIGIN,
    scores: { scoreStore: memoryScoreStore(() => NOW) },
    ...overrides,
  });
}

function event(options: {
  method?: string;
  query?: Record<string, string>;
  body?: unknown;
  address?: string;
  path?: string;
} = {}): FnUrlEvent {
  return {
    rawPath: options.path ?? '/scores',
    queryStringParameters: options.query ?? {
      lang: 'fr',
      date: ACTIVE_DATE,
      mode: 'sentence',
    },
    requestContext: { http: { method: options.method ?? 'GET', sourceIp: '127.0.0.1' } },
    headers: options.address
      ? { [VIEWER_IP_HEADER]: options.address, 'content-type': 'application/json' }
      : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  };
}

function parsed(response: { body: string }): ScoreHistogram {
  return JSON.parse(response.body) as ScoreHistogram;
}

describe('derivedHistogram — the day\'s rows ARE the population (#187)', () => {
  it('builds one exact ascending bucket per distinct score, ties counted together', () => {
    const rows = [
      { publicId: 'a', score: 9 },
      { publicId: 'b', score: 4 },
      { publicId: 'c', score: 9 },
      { publicId: 'd', score: 31 },
    ];
    expect(derivedHistogram(rows, 9)).toEqual({
      buckets: [
        { min: 4, max: 4, count: 1 },
        { min: 9, max: 9, count: 2 },
        { min: 31, max: 31, count: 1 },
      ],
      total: 4,
      bucket: 1,
    });
    expect(derivedHistogram(rows, null).bucket).toBeNull();
    expect(derivedHistogram([], null)).toEqual({ buckets: [], total: 0, bucket: null });
  });
});

describe('GET /scores', () => {
  it('returns an empty, non-cacheable histogram for a published daily with no rows', async () => {
    const response = await makeHandler()(event());
    expect(response.statusCode).toBe(200);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(response.headers['Access-Control-Allow-Origin']).toBe(ORIGIN);
    expect(parsed(response)).toEqual({ buckets: [], total: 0, bucket: null });
  });

  it('serves the day\'s recorded rows as exact ascending bands with no caller bucket', async () => {
    const scoreStore = memoryScoreStore(() => NOW);
    const key = { date: ACTIVE_DATE, lang: 'fr', mode: 'sentence' as const };
    for (const [publicId, score] of [['a', 9], ['b', 4], ['c', 9]] as const) {
      await scoreStore.submit({
        ...key,
        publicId,
        score,
        submittedAt: NOW.toISOString(),
        ipHash: `hash-${publicId}`,
        expiresAt: 0,
        requestToken: `token-${publicId}`,
      });
    }
    const response = await makeHandler({ scores: { scoreStore } })(event());
    expect(parsed(response)).toEqual({
      buckets: [
        { min: 4, max: 4, count: 1 },
        { min: 9, max: 9, count: 2 },
      ],
      total: 3,
      // The read carries no identity, so a revisiting client locates its own score in the
      // ranges itself.
      bucket: null,
    });
  });

  it.each([
    [{ date: ACTIVE_DATE, mode: 'sentence' }, 'missing lang'],
    [{ lang: 'de', date: ACTIVE_DATE, mode: 'sentence' }, 'unsupported lang'],
    [{ lang: 'fr', mode: 'sentence' }, 'missing date'],
    [{ lang: 'fr', date: '2026-02-30', mode: 'sentence' }, 'malformed date'],
    [{ lang: 'fr', date: ACTIVE_DATE }, 'missing mode'],
    [{ lang: 'fr', date: ACTIVE_DATE, mode: 'arcade' }, 'unknown mode'],
  ])('rejects malformed daily parameters: %s (%s)', async (query, _label) => {
    const response = await makeHandler()(event({ query }));
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe('bad_request');
  });

  it('serves active +1 but hides active +2 even when a puzzle store could contain it', async () => {
    const next = await makeHandler()(event({ query: { lang: 'fr', date: NEXT_DATE, mode: 'word' } }));
    expect(next.statusCode).toBe(200);

    const futureStore: PuzzleStore = {
      async getPuzzle() { return SENTENCE; },
      async getWordPuzzle() { return WORD; },
      async getSlice() { return null; },
    };
    const future = await makeHandler({ store: futureStore })(
      event({ query: { lang: 'fr', date: FUTURE_DATE, mode: 'word' } }),
    );
    expect(future.statusCode).toBe(404);
    expect(JSON.parse(future.body).error).toBe('not_found');
  });

  it('returns 404 for an unpublished daily instead of creating an empty population', async () => {
    const response = await makeHandler()(
      event({ query: { lang: 'fr', date: '2026-08-01', mode: 'sentence' } }),
    );
    expect(response.statusCode).toBe(404);
  });
});

// CONTRACT (#203): there is NO score POST. The client no longer claims a score, so the
// route has no write path to gate, validate or dedup — a POST is a named 405, and the
// refusal comes BEFORE any body or parameter is read, since there is nothing a body could
// make it do.
describe('the score POST is retired (#203)', () => {
  it('refuses POST with a named 405, whatever the body says', async () => {
    const response = await makeHandler()(
      event({ method: 'POST', body: { secret: SECRET, score: 9, turnstileToken: 'token' } }),
    );
    expect(response.statusCode).toBe(405);
    expect(JSON.parse(response.body).error).toBe('method_not_allowed');
    expect(response.headers['Cache-Control']).toBe('no-store');
  });

  it('refuses a malformed POST body the same way, rather than 400-ing it', async () => {
    const malformed = event({ method: 'POST' });
    malformed.body = '{';
    expect((await makeHandler()(malformed)).statusCode).toBe(405);
  });
});

describe('trusted client identity', () => {
  it('reads the CDN-stamped viewer address only, and ignores spoofable forwarded chains', () => {
    expect(clientIp(event({ address: '198.51.100.10' }))).toBe('198.51.100.10');
    expect(clientIp(event({ address: '2001:db8::1' }))).toBe('2001:db8::1');
    // Anything that is not a bare address is no identity at all — never a partial parse.
    expect(clientIp(event({ address: '198.51.100.10:46532' }))).toBeNull();
    expect(clientIp(event({ address: 'not-an-ip' }))).toBeNull();
    const spoofed = event();
    spoofed.headers = { 'x-forwarded-for': '203.0.113.99' };
    expect(clientIp(spoofed)).toBeNull();
    expect(clientIp(spoofed, true)).toBe('127.0.0.1');
  });

  it('uses a keyed digest: stable for one IP, different across IPs, and contains no raw IP', () => {
    const secret = 'a-secure-test-secret-with-at-least-32-bytes';
    const first = hashClientIp('198.51.100.10', secret);
    expect(first).toBe(hashClientIp('198.51.100.10', secret));
    expect(first).not.toBe(hashClientIp('198.51.100.11', secret));
    expect(first).not.toContain('198.51.100.10');
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });
});
