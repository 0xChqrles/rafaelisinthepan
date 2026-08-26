import { describe, expect, it } from 'vitest';
import { activeDate, generatePublicId, type Board } from '@whippin/shared';
import { createHandler } from './handler';
import { memoryDeviceStore } from './memoryDeviceStore';
import { memoryFriendStore } from './memoryFriendStore';
import { memoryProfileStore } from './memoryProfileStore';
import type { FnUrlEvent } from './respond';
import type { ScoreRow, ScoreStore } from './scoreStore';
import type { PuzzleStore } from './store';
import { seedDevice } from './testDevice';

// The /board route (#190): the GLOBAL top-50 read (anonymous GET) and the FRIENDS board
// (authenticated POST). The ranking rules themselves are contract-tested in
// @whippin/shared/leaderboard.test.ts; what this asserts is the ROUTE — params, auth,
// and the response carrying ranks + profiles the way a board renders them.

const NOW = new Date('2026-08-19T12:00:00Z');
const DATE = activeDate(NOW);

const emptyStore: PuzzleStore = {
  getPuzzle: async () => null,
  getWordPuzzle: async () => null,
  getSlice: async () => null,
};

// A read-only score population: /board never writes, so `submit` is unreachable.
function fixedScores(rows: ScoreRow[]): ScoreStore {
  return {
    list: async () => rows,
    getMany: async (_key, ids) => rows.filter((row) => ids.includes(row.publicId)),
    submit: async () => {
      throw new Error('the board route never submits');
    },
  };
}

async function makeHandler(rows: ScoreRow[]) {
  const profiles = memoryProfileStore();
  const friends = memoryFriendStore();
  const devices = memoryDeviceStore();
  const handler = createHandler({
    store: emptyStore,
    now: () => NOW,
    scores: { scoreStore: fixedScores(rows) },
    profiles,
    friends,
    deviceStore: devices,
    devices: {
      turnstile: { verify: async () => true },
      allowSourceIp: true,
    },
  });
  return { handler, profiles, friends, devices };
}

// The caller's device, seeded on an account the test already named — the friends face
// resolves the caller from the token, so the board it answers is that ACCOUNT's.
const callerOn = (devices: ReturnType<typeof memoryDeviceStore>, accountId: string) =>
  seedDevice(devices, { accountId });

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
    const { handler } = await makeHandler([]);
    expect((await handler(get({ date: DATE, mode: 'sentence' }))).statusCode).toBe(400);
    expect((await handler(get({ lang: 'de', date: DATE, mode: 'sentence' }))).statusCode).toBe(400);
    // The support check must be an OWN-property check: `map[lang] === undefined` walks
    // the prototype chain, so Object.prototype keys would pass as "languages" and reach
    // the store key. /scores is masked by its puzzle-store 404; /board reads no puzzle
    // store, so the hole would be reachable to a 200 here.
    for (const lang of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect((await handler(get({ lang, date: DATE, mode: 'sentence' }))).statusCode).toBe(400);
    }
    expect((await handler(get({ lang: 'fr', date: DATE }))).statusCode).toBe(400);
    expect((await handler(get({ lang: 'fr', date: DATE, mode: 'x' }))).statusCode).toBe(400);
    expect((await handler(get({ lang: 'fr', mode: 'sentence' }))).statusCode).toBe(400);
    expect((await handler(get({ ...QUERY, id: 'NOT-AN-ID' }))).statusCode).toBe(400);
  });

  it('guards the future beyond +1 day like the puzzle route', async () => {
    const { handler } = await makeHandler([]);
    const future = activeDate(new Date(NOW.getTime() + 3 * 24 * 3600 * 1000));
    expect((await handler(get({ ...QUERY, date: future }))).statusCode).toBe(404);
  });

  it('answers the global board with competition ranks and attached profiles', async () => {
    const me = generatePublicId();
    const other = generatePublicId();
    const { handler, profiles } = await makeHandler([
      { publicId: me, score: 7 },
      { publicId: other, score: 3 },
    ]);
    await profiles.upsert({ publicId: other, name: 'Zoe', avatar: 'A'.repeat(19), now: NOW.toISOString() });

    const result = await handler(get(QUERY));
    expect(result.statusCode).toBe(200);
    expect(result.headers['Cache-Control']).toBe('no-store');
    const board = JSON.parse(result.body) as Board;
    // Sentence: lower is better — the 3 leads; the uncustomized player degrades honestly.
    expect(board.rows).toEqual([
      { publicId: other, score: 3, rank: 1, name: 'Zoe', avatar: 'A'.repeat(19) },
      { publicId: me, score: 7, rank: 2, name: '', avatar: null },
    ]);
    expect(board.own).toBeNull();
    // The global population IS the recorded scores — nobody waits on it.
    expect(board.waiting).toEqual([]);
  });

  it('windows a caller below the top-50 cut when `id` names them', async () => {
    const ids = Array.from({ length: 60 }, () => generatePublicId());
    const { handler } = await makeHandler(
      ids.map((publicId, i) => ({ publicId, score: i + 1 })),
    );

    const result = await handler(get({ ...QUERY, id: ids[57] })); // score 58, position 58
    const board = JSON.parse(result.body) as Board;
    expect(board.rows).toHaveLength(50);
    expect(board.own?.map((row) => row.score)).toEqual([56, 57, 58, 59, 60]);
  });

  it('cuts straight through a tie: 50 rows max, boundary members at the shared rank', async () => {
    const ids = Array.from({ length: 70 }, () => generatePublicId());
    const rows = ids.map((publicId, i) => ({ publicId, score: i < 40 ? i + 1 : 99 }));
    const { handler } = await makeHandler(rows);

    const board = JSON.parse((await handler(get(QUERY))).body) as Board;
    expect(board.rows).toHaveLength(50);
    // Nothing folded (user-decided 2026-08-20): the tie's first ten members show as
    // ordinary rows, all at rank 41.
    expect(board.rows.slice(40).every((row) => row.rank === 41 && row.score === 99)).toBe(true);
  });

  it('answers the friends board only for the caller edges plus themselves', async () => {
    const me = generatePublicId();
    const friend = generatePublicId();
    const stranger = generatePublicId();
    const { handler, friends, devices } = await makeHandler([
      { publicId: me, score: 9 },
      { publicId: friend, score: 4 },
      { publicId: stranger, score: 1 },
    ]);
    await friends.link({ publicId: me, friendId: friend, createdAt: NOW.toISOString() });
    const caller = await callerOn(devices, me);

    const result = await handler(post(QUERY, { token: caller.token }));
    expect(result.statusCode).toBe(200);
    const board = JSON.parse(result.body) as Board;
    // The stranger's better score is not on this board — that is the whole point.
    expect(board.rows.map((row) => [row.publicId, row.rank])).toEqual([
      [friend, 1],
      [me, 2],
    ]);
    expect(board.own).toBeNull();
  });

  it('dresses a failed or empty-avatar profile read as the missing profile, never a 500', async () => {
    const me = generatePublicId();
    const other = generatePublicId();
    // One player's profile read throws (a throttled GetItem), the other's answers with
    // an EMPTY avatar string (a row missing the attribute). The board is decorative
    // dressing over rows that already answered, so both degrade to name '' / avatar
    // null — the client's assigned-identity fallback — instead of failing the board.
    const flaky = {
      get: async (publicId: string) => {
        if (publicId === me) throw new Error('throttled');
        return { publicId, name: 'Zoe', avatar: '' };
      },
      upsert: async () => {},
    };
    const handler = createHandler({
      store: emptyStore,
      now: () => NOW,
      scores: {
        scoreStore: fixedScores([
          { publicId: me, score: 7 },
          { publicId: other, score: 3 },
        ]),
      },
      profiles: flaky,
      friends: memoryFriendStore(),
      deviceStore: memoryDeviceStore(),
      devices: {
        turnstile: { verify: async () => true },
        allowSourceIp: true,
      },
    });

    const result = await handler(get(QUERY));
    expect(result.statusCode).toBe(200);
    const board = JSON.parse(result.body) as Board;
    expect(board.rows).toEqual([
      { publicId: other, score: 3, rank: 1, name: 'Zoe', avatar: null },
      { publicId: me, score: 7, rank: 2, name: '', avatar: null },
    ]);
  });

  it("shows friends' scores before the caller has played (own row simply absent)", async () => {
    const me = generatePublicId();
    const friend = generatePublicId();
    const { handler, friends, devices } = await makeHandler([{ publicId: friend, score: 4 }]);
    await friends.link({ publicId: me, friendId: friend, createdAt: NOW.toISOString() });
    const caller = await callerOn(devices, me);

    const board = JSON.parse((await handler(post(QUERY, { token: caller.token }))).body) as Board;
    expect(board.rows.map((row) => row.publicId)).toEqual([friend]);
    // The caller never waits on their own board — the identity strip already shows them.
    expect(board.waiting).toEqual([]);
  });

  it('names a friend with no score today in `waiting` instead of dropping them', async () => {
    const me = generatePublicId();
    const played = generatePublicId();
    const notYet = generatePublicId();
    const { handler, friends, profiles, devices } = await makeHandler([
      { publicId: me, score: 9 },
      { publicId: played, score: 4 },
    ]);
    await friends.link({ publicId: me, friendId: played, createdAt: NOW.toISOString() });
    await friends.link({ publicId: me, friendId: notYet, createdAt: NOW.toISOString() });
    await profiles.upsert({ publicId: notYet, name: 'Later', avatar: 'A'.repeat(19), now: NOW.toISOString() });
    const caller = await callerOn(devices, me);

    const board = JSON.parse((await handler(post(QUERY, { token: caller.token }))).body) as Board;
    expect(board.rows.map((row) => row.publicId)).toEqual([played, me]);
    expect(board.waiting).toEqual([
      { publicId: notYet, name: 'Later', avatar: 'A'.repeat(19) },
    ]);
  });

  it('refuses a friends read without a canonical device token (the auth IS the body)', async () => {
    const { handler } = await makeHandler([]);
    expect((await handler(post(QUERY, {}))).statusCode).toBe(400);
    expect((await handler(post(QUERY, { token: 'nope' }))).statusCode).toBe(400);
    // Well-formed but never issued: the distinct answer that signs a device out (#216).
    const stranger = await handler(post(QUERY, { token: 'f'.repeat(64) }));
    expect(stranger.statusCode).toBe(401);
    expect(JSON.parse(stranger.body).error).toBe('unknown_device');
  });

  it('answers an empty day honestly on both faces', async () => {
    const { handler, devices } = await makeHandler([]);
    const global = JSON.parse((await handler(get(QUERY))).body) as Board;
    expect(global).toEqual({ rows: [], own: null, waiting: [] });
    const caller = await seedDevice(devices);
    const mine = JSON.parse((await handler(post(QUERY, { token: caller.token }))).body) as Board;
    expect(mine).toEqual({ rows: [], own: null, waiting: [] });
  });
});
