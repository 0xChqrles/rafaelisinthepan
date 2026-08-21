// CONTRACT (#169/#187): /scores is date/lang/mode-addressed, verifies Turnstile on POST,
// authenticates the player by the secret key alone (deriving the publicId — nothing
// secret stored), validates a score against the published daily, writes ONE
// first-write-wins row per (date, lang, mode, publicId) with a five-write HMAC-IP volume
// cap, and serves the histogram DERIVED from the day's rows with the caller's bucket.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VIEWER_IP_HEADER,
  generateSecret,
  type Puzzle,
  type ScoreHistogram,
  type WordPuzzle,
} from '@whippin/shared';
import { createHandler, type HandlerDeps } from './handler';
import { memoryScoreStore } from './memoryScoreStore';
import { WORD_SCORE_ZONE } from './scoreLimits';
import { SCORE_SUBMISSION_LIMIT } from './scoreStore';
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
  };
}

const verify = vi.fn(async () => true);

function makeHandler(overrides: Partial<HandlerDeps> = {}) {
  return createHandler({
    store: puzzleStore(),
    now: () => NOW,
    allowedOrigin: ORIGIN,
    scores: {
      scoreStore: memoryScoreStore(() => NOW),
      turnstile: { verify },
      ipHmacSecret: 'a-secure-test-secret-with-at-least-32-bytes',
      allowSourceIp: true,
    },
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

beforeEach(() => {
  verify.mockReset();
  verify.mockResolvedValue(true);
});

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
    expect(verify).not.toHaveBeenCalled();
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

describe('POST /scores', () => {
  it('verifies Turnstile once, records one player row, and returns the included score', async () => {
    const handler = makeHandler();
    const response = await handler(
      event({
        method: 'POST',
        body: { secret: SECRET, score: 9, turnstileToken: 'token-1' },
        address: '198.51.100.10',
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith('token-1', '198.51.100.10');
    expect(parsed(response)).toEqual({
      buckets: [{ min: 9, max: 9, count: 1 }],
      total: 1,
      bucket: 0,
    });

    // A read derives the same population but carries no caller identity/bucket.
    const read = parsed(await handler(event()));
    expect(read).toEqual({ buckets: [{ min: 9, max: 9, count: 1 }], total: 1, bucket: null });
  });

  it('derives the histogram from the recorded rows: ascending exact bands, ties shared', async () => {
    const handler = makeHandler();
    for (const [index, score] of [31, 4, 9, 9].entries()) {
      await handler(
        event({
          method: 'POST',
          body: { secret: generateSecret(), score, turnstileToken: `token-${index}` },
          address: `198.51.100.${index + 30}`,
        }),
      );
    }
    const last = await handler(
      event({
        method: 'POST',
        body: { secret: generateSecret(), score: 9, turnstileToken: 'token-last' },
        address: '198.51.100.40',
      }),
    );
    expect(parsed(last)).toEqual({
      buckets: [
        { min: 4, max: 4, count: 1 },
        { min: 9, max: 9, count: 3 },
        { min: 31, max: 31, count: 1 },
      ],
      total: 5,
      bucket: 1,
    });
  });

  it('rejects a missing or malformed player key before any write', async () => {
    const handler = makeHandler();
    for (const secret of [undefined, 42, 'not-a-key', SECRET.toUpperCase()]) {
      const response = await handler(
        event({ method: 'POST', body: { secret, score: 4, turnstileToken: 'token' } }),
      );
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toBe('bad_request');
    }
    expect(parsed(await handler(event())).total).toBe(0);
  });

  it('is first-write-wins per player: a second submission changes nothing and reports the stored row', async () => {
    const handler = makeHandler();
    await handler(
      event({ method: 'POST', body: { secret: SECRET, score: 9, turnstileToken: 'first' } }),
    );
    const replay = await handler(
      event({ method: 'POST', body: { secret: SECRET, score: 3, turnstileToken: 'second' } }),
    );
    // Accepted (the conversation is over either way), but the population still holds ONE
    // row — the first score — and the reported bucket is the STORED row's, never the
    // resubmission's.
    expect(replay.statusCode).toBe(200);
    expect(parsed(replay)).toEqual({
      buckets: [{ min: 9, max: 9, count: 1 }],
      total: 1,
      bucket: 0,
    });
  });

  it('keeps sentence and Word populations separate', async () => {
    const handler = makeHandler();
    await handler(
      event({ method: 'POST', body: { secret: SECRET, score: 4, turnstileToken: 'sentence' } }),
    );
    const word = await handler(
      event({
        method: 'POST',
        query: { lang: 'fr', date: ACTIVE_DATE, mode: 'word' },
        body: { secret: SECRET, score: 2, turnstileToken: 'word' },
      }),
    );
    expect(word.statusCode).toBe(200);
    expect(parsed(word).total).toBe(1);
    expect(parsed(await handler(event())).total).toBe(1);
  });

  it('rejects a missing/invalid token and records nothing', async () => {
    const handler = makeHandler();
    const missing = await handler(event({ method: 'POST', body: { secret: SECRET, score: 4 } }));
    expect(missing.statusCode).toBe(403);
    expect(verify).not.toHaveBeenCalled();

    verify.mockResolvedValueOnce(false);
    const invalid = await handler(
      event({ method: 'POST', body: { secret: SECRET, score: 4, turnstileToken: 'invalid' } }),
    );
    expect(invalid.statusCode).toBe(403);
    expect(parsed(await handler(event())).total).toBe(0);
  });

  it('rejects scores outside the possible range for this puzzle and mode', async () => {
    const handler = makeHandler();
    const sentence = await handler(
      event({
        method: 'POST',
        body: { secret: SECRET, score: 0, turnstileToken: 'sentence-zero' },
      }),
    );
    expect(sentence.statusCode).toBe(400);
    expect(JSON.parse(sentence.body).error).toBe('invalid_score');

    // The fixture has only two distinct claimable groups, even though the global Word
    // field reaches rank 1,000. Three is impossible for THIS daily.
    const word = await handler(
      event({
        method: 'POST',
        query: { lang: 'fr', date: ACTIVE_DATE, mode: 'word' },
        body: { secret: SECRET, score: 3, turnstileToken: 'word-three' },
      }),
    );
    expect(word.statusCode).toBe(400);
    expect(JSON.parse(word.body).error).toBe('invalid_score');
  });

  it('allows zero in Word mode', async () => {
    const response = await makeHandler()(
      event({
        method: 'POST',
        query: { lang: 'fr', date: ACTIVE_DATE, mode: 'word' },
        body: { secret: SECRET, score: 0, turnstileToken: 'dnf' },
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(parsed(response).bucket).toBe(0);
  });

  it('caps one daily/IP at five rows without a sixth write, but another IP remains eligible', async () => {
    const handler = makeHandler();
    for (let index = 0; index < SCORE_SUBMISSION_LIMIT; index += 1) {
      const response = await handler(
        event({
          method: 'POST',
          body: { secret: generateSecret(), score: 4, turnstileToken: `token-${index}` },
          address: '198.51.100.20',
        }),
      );
      expect(response.statusCode).toBe(200);
    }
    const capped = await handler(
      event({
        method: 'POST',
        body: { secret: generateSecret(), score: 4, turnstileToken: 'token-six' },
        address: '198.51.100.20',
      }),
    );
    expect(capped.statusCode).toBe(429);
    expect(JSON.parse(capped.body).error).toBe('submission_limit');
    expect(parsed(await handler(event())).total).toBe(SCORE_SUBMISSION_LIMIT);

    const household = await handler(
      event({
        method: 'POST',
        body: { secret: generateSecret(), score: 4, turnstileToken: 'other-ip' },
        address: '198.51.100.21',
      }),
    );
    expect(household.statusCode).toBe(200);
    expect(parsed(household).total).toBe(SCORE_SUBMISSION_LIMIT + 1);
  });

  it('rejects malformed JSON/body fields and disallows POST on other routes', async () => {
    const malformed = event({ method: 'POST' });
    malformed.body = '{';
    expect((await makeHandler()(malformed)).statusCode).toBe(400);
    expect(
      (
        await makeHandler()(
          event({
            method: 'POST',
            body: { secret: SECRET, score: 1.5, turnstileToken: 'token' },
          }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await makeHandler()(
          event({
            method: 'POST',
            path: '/',
            body: { secret: SECRET, score: 4, turnstileToken: 'token' },
          }),
        )
      ).statusCode,
    ).toBe(405);
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

// CONTRACT (2026-08-15): the token hash is the idempotency key precisely BECAUSE a real
// Turnstile token is single-use — one submission retried internally must never count
// twice. A verifier whose tokens repeat (the local accept-all one: Cloudflare's test site
// key hands out one dummy token forever) breaks that premise, so the local wiring declares
// it and the handler keys on a fresh id instead. Without this, every local submission after
// the first is waved through as a "replay" and a laptop's histogram reads zero forever.
describe('POST /scores — idempotency keys and non-single-use tokens', () => {
  const submit = (
    handler: ReturnType<typeof makeHandler>,
    secret: string,
    score: number,
    token: string,
  ) =>
    handler(
      event({
        method: 'POST',
        body: { secret, score, turnstileToken: token },
        address: '203.0.113.9',
      }),
    );

  it('treats a REPEATED token as one submission when tokens are single-use', async () => {
    const handler = makeHandler();
    await submit(handler, SECRET, 2, 'same-token');
    const second = await submit(handler, generateSecret(), 2, 'same-token');
    expect(second.statusCode).toBe(200);
    // Accepted, but the replay changed nothing: still exactly one recorded score.
    expect(parsed(second).total).toBe(1);
  });

  it('counts each player when the verifier’s tokens are NOT single-use', async () => {
    const handler = makeHandler({
      scores: {
        scoreStore: memoryScoreStore(() => NOW),
        turnstile: { verify },
        ipHmacSecret: 'a-secure-test-secret-with-at-least-32-bytes',
        allowSourceIp: true,
        singleUseTokens: false,
      },
    });
    await submit(handler, generateSecret(), 2, 'XXXX.DUMMY.TOKEN.XXXX');
    const second = await submit(handler, generateSecret(), 2, 'XXXX.DUMMY.TOKEN.XXXX');
    expect(second.statusCode).toBe(200);
    expect(parsed(second).total).toBe(2);
  });

  it('still caps a single HMAC-IP, whatever the tokens look like', async () => {
    const handler = makeHandler({
      scores: {
        scoreStore: memoryScoreStore(() => NOW),
        turnstile: { verify },
        ipHmacSecret: 'a-secure-test-secret-with-at-least-32-bytes',
        allowSourceIp: true,
        singleUseTokens: false,
      },
    });
    for (let i = 0; i < SCORE_SUBMISSION_LIMIT; i += 1) {
      expect((await submit(handler, generateSecret(), 2, 'dummy')).statusCode).toBe(200);
    }
    expect((await submit(handler, generateSecret(), 2, 'dummy')).statusCode).toBe(429);
  });
});
