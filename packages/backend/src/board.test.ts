import { describe, expect, it } from 'vitest';
import { activeDate, publicIdFromSecret, type Board } from '@whippin/shared';
import { createHandler } from './handler';
import { memoryFriendStore } from './memoryFriendStore';
import { memoryProfileStore } from './memoryProfileStore';
import type { FnUrlEvent } from './respond';
import type { ScoreRow, ScoreStore } from './scoreStore';
import type { PuzzleStore } from './store';
import { localTurnstileVerifier } from './turnstile';

// The /board route (#190): the GLOBAL top-50 read (anonymous GET) and the FRIENDS board
// (authenticated POST). The ranking rules themselves are contract-tested in
// @whippin/shared/leaderboard.test.ts; what this asserts is the ROUTE — params, auth,
// and the response carrying ranks + profiles the way a board renders them.

const SECRET = 'a'.repeat(32);
const FRIEND_SECRET = 'b'.repeat(32);
const STRANGER_SECRET = 'c'.repeat(32);

const NOW = new Date('2026-08-19T12:00:00Z');
const DATE = activeDate(NOW);

const emptyStore: PuzzleStore = {
  getPuzzle: async () => null,
  getWordPuzzle: async () => null,
};

// A read-only score population: /board never writes, so `submit` is unreachable.
function fixedScores(rows: ScoreRow[]): ScoreStore {
  return {
    list: async () => rows,
    submit: async () => {
      throw new Error('the board route never submits');
    },
  };
}

function makeHandler(rows: ScoreRow[]) {
  const profiles = memoryProfileStore();
  const friends = memoryFriendStore();
  const handler = createHandler({
    store: emptyStore,
    now: () => NOW,
    scores: { scoreStore: fixedScores(rows), turnstile: localTurnstileVerifier, ipHmacSecret: 'x'.repeat(64) },
    profiles,
    friends,
  });
  return { handler, profiles, friends };
}

function get(query: Record<string, string>): FnUrlEvent {
  return {
    rawPath: '/board',
    queryStringParameters: query,
    requestContext: { http: { method: 'GET' } },
  };
}

function post(query: Record<string, string>, body: unknown): FnUrlEvent {
  return {
    rawPath: '/board',
    queryStringParameters: query,
    requestContext: { http: { method: 'POST' } },
    body: JSON.stringify(body),
  };
}

const QUERY = { lang: 'fr', date: DATE, mode: 'sentence' };

describe('board route (#190)', () => {
  it('rejects a missing/unsupported lang, mode and date (protocol violations)', async () => {
    const { handler } = makeHandler([]);
    expect((await handler(get({ date: DATE, mode: 'sentence' }))).statusCode).toBe(400);
    expect((await handler(get({ lang: 'fr', date: DATE }))).statusCode).toBe(400);
    expect((await handler(get({ lang: 'fr', date: DATE, mode: 'x' }))).statusCode).toBe(400);
    expect((await handler(get({ lang: 'fr', mode: 'sentence' }))).statusCode).toBe(400);
    expect((await handler(get({ ...QUERY, id: 'NOT-AN-ID' }))).statusCode).toBe(400);
  });

  it('guards the future beyond +1 day like the puzzle route', async () => {
    const { handler } = makeHandler([]);
    const future = activeDate(new Date(NOW.getTime() + 3 * 24 * 3600 * 1000));
    expect((await handler(get({ ...QUERY, date: future }))).statusCode).toBe(404);
  });

  it('answers the global board with competition ranks and attached profiles', async () => {
    const me = await publicIdFromSecret(SECRET);
    const other = await publicIdFromSecret(FRIEND_SECRET);
    const { handler, profiles } = makeHandler([
      { publicId: me, score: 7 },
      { publicId: other, score: 3 },
    ]);
    await profiles.upsert({ publicId: other, name: 'Zoe', avatar: 'A'.repeat(19), now: NOW.toISOString() });

    const result = await handler(get(QUERY));
    expect(result.statusCode).toBe(200);
    expect(result.headers['Cache-Control']).toBe('no-store');
    const board = JSON.parse(result.body) as Board;
    expect(board.total).toBe(2);
    // Sentence: lower is better — the 3 leads; the uncustomized player degrades honestly.
    expect(board.rows).toEqual([
      { publicId: other, score: 3, rank: 1, name: 'Zoe', avatar: 'A'.repeat(19) },
      { publicId: me, score: 7, rank: 2, name: '', avatar: null },
    ]);
    expect(board.overflow).toBeNull();
    expect(board.own).toBeNull();
  });

  it('windows a caller below the top-50 cut when `id` names them', async () => {
    const ids = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        publicIdFromSecret(String(i).padStart(2, '0').repeat(16)),
      ),
    );
    const { handler } = makeHandler(ids.map((publicId, i) => ({ publicId, score: i + 1 })));

    const result = await handler(get({ ...QUERY, id: ids[57] })); // score 58, position 58
    const board = JSON.parse(result.body) as Board;
    expect(board.rows).toHaveLength(50);
    expect(board.overflow).toBeNull();
    expect(board.own?.map((row) => row.score)).toEqual([56, 57, 58, 59, 60]);
  });

  it('collapses a tie group straddling the cut into the overflow line', async () => {
    const ids = await Promise.all(
      Array.from({ length: 70 }, (_, i) =>
        publicIdFromSecret(String(i).padStart(2, '0').repeat(16)),
      ),
    );
    const rows = ids.map((publicId, i) => ({ publicId, score: i < 40 ? i + 1 : 99 }));
    const { handler } = makeHandler(rows);

    const board = JSON.parse((await handler(get(QUERY))).body) as Board;
    expect(board.rows).toHaveLength(40);
    expect(board.overflow).toEqual({ rank: 41, count: 30 });
  });

  it('answers the friends board only for the caller edges plus themselves', async () => {
    const me = await publicIdFromSecret(SECRET);
    const friend = await publicIdFromSecret(FRIEND_SECRET);
    const stranger = await publicIdFromSecret(STRANGER_SECRET);
    const { handler, friends } = makeHandler([
      { publicId: me, score: 9 },
      { publicId: friend, score: 4 },
      { publicId: stranger, score: 1 },
    ]);
    await friends.link({ publicId: me, friendId: friend, createdAt: NOW.toISOString() });

    const result = await handler(post(QUERY, { secret: SECRET }));
    expect(result.statusCode).toBe(200);
    const board = JSON.parse(result.body) as Board;
    // The stranger's better score is not on this board — that is the whole point.
    expect(board.rows.map((row) => [row.publicId, row.rank])).toEqual([
      [friend, 1],
      [me, 2],
    ]);
    expect(board.total).toBe(2);
    expect(board.overflow).toBeNull();
    expect(board.own).toBeNull();
  });

  it("shows friends' scores before the caller has played (own row simply absent)", async () => {
    const me = await publicIdFromSecret(SECRET);
    const friend = await publicIdFromSecret(FRIEND_SECRET);
    const { handler, friends } = makeHandler([{ publicId: friend, score: 4 }]);
    await friends.link({ publicId: me, friendId: friend, createdAt: NOW.toISOString() });

    const board = JSON.parse((await handler(post(QUERY, { secret: SECRET }))).body) as Board;
    expect(board.rows.map((row) => row.publicId)).toEqual([friend]);
  });

  it('refuses a friends read without a well-formed secret (the auth IS the body)', async () => {
    const { handler } = makeHandler([]);
    expect((await handler(post(QUERY, {}))).statusCode).toBe(400);
    expect((await handler(post(QUERY, { secret: 'nope' }))).statusCode).toBe(400);
  });

  it('answers an empty day honestly on both faces', async () => {
    const { handler } = makeHandler([]);
    const global = JSON.parse((await handler(get(QUERY))).body) as Board;
    expect(global).toEqual({ total: 0, rows: [], overflow: null, own: null });
    const mine = JSON.parse((await handler(post(QUERY, { secret: SECRET }))).body) as Board;
    expect(mine).toEqual({ total: 0, rows: [], overflow: null, own: null });
  });
});
