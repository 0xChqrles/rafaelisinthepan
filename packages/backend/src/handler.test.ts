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

function fakeStore(): PuzzleStore {
  return {
    async getPuzzle(date, lang) {
      return date === ACTIVE_DATE && lang === 'fr' ? PUZZLE : null;
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
    const res = await makeHandler()(event({ query: { lang: 'fr' } }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toMatch(/application\/json/);
    expect(JSON.parse(res.body)).toEqual(PUZZLE);
  });

  it('sets CORS + daily Cache-Control on a hit', async () => {
    const res = await makeHandler()(event({ query: { lang: 'fr' } }));
    expect(res.headers['Access-Control-Allow-Origin']).toBe(ORIGIN);
    expect(res.headers['Cache-Control']).toMatch(/max-age=\d+/);
  });

  it('missing puzzle -> clean JSON 404, never 500', async () => {
    const res = await makeHandler()(event({ query: { lang: 'en' } }));
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
      },
      now: () => FIXED_NOW,
      allowedOrigin: ORIGIN,
    });
    const res = await handler(event({ query: { lang: 'fr' } }));
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

describe('today metadata endpoint', () => {
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
});
