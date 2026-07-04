// CONTRACT (issue #2 acceptance criteria): the handler resolves the day's puzzle for a
// requested lang, returns it in the front's `Puzzle` shape, answers a missing puzzle
// with a clean JSON 404 (never a 500), sends CORS headers, and exposes day metadata.

import { describe, it, expect } from 'vitest';
import type { Puzzle } from '@whippin/shared';
import { createHandler, type HandlerDeps } from './handler';
import type { FnUrlEvent } from './respond';
import type { PuzzleStore } from './store';

// A minimal but schema-valid puzzle, keyed by the date the fixed clock resolves to.
const PUZZLE: Puzzle = {
  lang: 'fr',
  words: ['la', 'forêt', 'ancienne'],
  holes: [
    {
      pos: 1,
      secret: { word: 'forêt', slug: 'foret' },
      start: { word: 'bois', slug: 'bois' },
      start_rank: 87,
    },
  ],
  ranks: {
    foret: {
      foret: { word: 'forêt', rank: 0 },
      bois: { word: 'bois', rank: 87 },
    },
  },
};

// 2026-06-29 10:00 EDT (14:00 UTC) -> active date "2026-06-29".
const FIXED_NOW = new Date('2026-06-29T14:00:00Z');
const ACTIVE_DATE = '2026-06-29';
const ORIGIN = 'https://whippin.example';
const VERSION = 'abc123def456'; // the content version the fake store reports for fr today

function fakeStore(): PuzzleStore {
  return {
    async getPuzzle(date, lang) {
      return date === ACTIVE_DATE && lang === 'fr' ? PUZZLE : null;
    },
    async version(date, lang) {
      return date === ACTIVE_DATE && lang === 'fr' ? VERSION : null;
    },
  };
}

function makeHandler(overrides: Partial<HandlerDeps> = {}) {
  return createHandler({
    store: fakeStore(),
    now: () => FIXED_NOW,
    allowedOrigin: ORIGIN,
    ...overrides,
  });
}

function event(opts: {
  method?: string;
  path?: string;
  query?: Record<string, string>;
}): FnUrlEvent {
  return {
    rawPath: opts.path ?? '/',
    queryStringParameters: opts.query ?? null,
    requestContext: { http: { method: opts.method ?? 'GET' } },
  };
}

describe('puzzle endpoint', () => {
  it('returns the day\'s puzzle for the requested lang, unchanged', async () => {
    const res = await makeHandler()(event({ query: { lang: 'fr', v: VERSION } }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toMatch(/application\/json/);
    expect(JSON.parse(res.body)).toEqual(PUZZLE);
  });

  it('sets CORS + an immutable Cache-Control on a hit (version-addressed URL, #42)', async () => {
    const res = await makeHandler()(event({ query: { lang: 'fr', v: VERSION } }));
    expect(res.headers['Access-Control-Allow-Origin']).toBe(ORIGIN);
    // The puzzle URL is content-addressed by `v`, so its bytes never change -> immutable.
    expect(res.headers['Cache-Control']).toMatch(/immutable/);
    expect(res.headers['Cache-Control']).toMatch(/max-age=\d+/);
  });

  it('requires `v` — a puzzle request without the version token is a 400 (#42)', async () => {
    // The endpoint is version-addressed; a missing `v` is a protocol violation, not a
    // silently-served puzzle at a non-content-addressed URL.
    const res = await makeHandler()(event({ query: { lang: 'fr' } }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('bad_request');
  });

  it('`v` is an opaque cache token — any non-empty value serves the current puzzle unchanged', async () => {
    // The handler keys only on `lang`; `v` never changes the body (it exists for the CDN
    // cache key), so a stale/garbage-but-present `v` still returns the current puzzle.
    const res = await makeHandler()(event({ query: { lang: 'fr', v: 'anything' } }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(PUZZLE);
  });

  it('stamps the served day (X-Puzzle-Date, CORS-exposed) so the client can detect a flip mid-pair', async () => {
    // The client fetches /today then the puzzle; when the 22:00 flip lands between the
    // two, the puzzle belongs to a different day than the pointer. The stamp is what
    // lets it detect that and re-run the pair.
    const res = await makeHandler()(event({ query: { lang: 'fr', v: VERSION } }));
    expect(res.headers['X-Puzzle-Date']).toBe(ACTIVE_DATE);
    expect(res.headers['Access-Control-Expose-Headers']).toMatch(/X-Puzzle-Date/);
  });

  it('missing puzzle -> clean JSON 404, never 500', async () => {
    const res = await makeHandler()(event({ query: { lang: 'en', v: 'x' } }));
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('not_found');
    expect(body).toMatchObject({ date: ACTIVE_DATE, lang: 'en' });
    expect(res.headers['Access-Control-Allow-Origin']).toBe(ORIGIN);
  });

  it('missing lang -> 400 bad_request', async () => {
    const res = await makeHandler()(event({}));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('bad_request');
  });

  it('malformed lang -> 400 bad_request', async () => {
    const res = await makeHandler()(event({ query: { lang: 'EN' } }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('bad_request');
  });

  it('a store failure surfaces as a JSON 500, not an unhandled throw', async () => {
    const handler = createHandler({
      store: {
        async getPuzzle() {
          throw new Error('s3 boom');
        },
        async version() {
          throw new Error('s3 boom');
        },
      },
      now: () => FIXED_NOW,
      allowedOrigin: ORIGIN,
    });
    const res = await handler(event({ query: { lang: 'fr', v: 'x' } }));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toBe('internal_error');
  });
});

describe('CORS preflight', () => {
  it('OPTIONS -> 204 with CORS headers and no body', async () => {
    const res = await makeHandler()(event({ method: 'OPTIONS' }));
    expect(res.statusCode).toBe(204);
    expect(res.headers['Access-Control-Allow-Origin']).toBe(ORIGIN);
    expect(res.headers['Access-Control-Allow-Methods']).toMatch(/GET/);
    expect(res.body).toBe('');
  });
});

describe('today metadata + version pointer endpoint (#42)', () => {
  it('exposes the server day and reset info', async () => {
    const res = await makeHandler()(event({ path: '/today' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.date).toBe(ACTIVE_DATE);
    expect(typeof body.dayNumber).toBe('number');
    expect(body.timeZone).toBe('America/New_York');
    expect(typeof body.secondsUntilNextReset).toBe('number');
    expect(body.nextResetAt).toBe('2026-06-30T02:00:00.000Z');
  });

  it('carries the current puzzle version for the requested lang', async () => {
    const res = await makeHandler()(event({ path: '/today', query: { lang: 'fr' } }));
    expect(JSON.parse(res.body).version).toBe(VERSION);
  });

  it('is never cached (no-store) so it always reflects the current version', async () => {
    const res = await makeHandler()(event({ path: '/today', query: { lang: 'fr' } }));
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('version is null when the lang has no puzzle, or when lang is absent/invalid', async () => {
    const noPuzzle = await makeHandler()(event({ path: '/today', query: { lang: 'en' } }));
    expect(JSON.parse(noPuzzle.body).version).toBeNull();

    const noLang = await makeHandler()(event({ path: '/today' }));
    expect(JSON.parse(noLang.body).version).toBeNull();

    const badLang = await makeHandler()(event({ path: '/today', query: { lang: 'EN' } }));
    expect(JSON.parse(badLang.body).version).toBeNull();
  });
});
