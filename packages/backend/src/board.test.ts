import { describe, expect, it } from 'vitest';
import {
  activeDate,
  generatePublicId,
  ROUND_GUESS_CAP,
  type Board,
  type Puzzle,
} from '@whippin/shared';
import { createHandler } from './handler';
import { memoryDeviceStore } from './memoryDeviceStore';
import { memoryFriendStore } from './memoryFriendStore';
import { memoryHistoryStore } from './memoryHistoryStore';
import { memoryProfileStore } from './memoryProfileStore';
import { memoryRoundStore } from './memoryRoundStore';
import type { FnUrlEvent } from './respond';
import type { RoundStore } from './roundStore';
import type { ScoreRow, ScoreStore } from './scoreStore';
import type { PuzzleStore } from './store';
import { seedDevice } from './testDevice';

// The /board route (#190): the GLOBAL top-50 read (anonymous GET) and the FRIENDS board
// (authenticated POST). The ranking rules themselves are contract-tested in
// @whippin/shared/leaderboard.test.ts; what this asserts is the ROUTE — params, auth,
// and the response carrying ranks + profiles the way a board renders them — plus the
// #206 in-progress rows: a friend with a stored round but no recorded score is PLAYING,
// with the EXACT deduped try count (against the day's full artifact) and the stored
// derived percentage, on the friends POST only.

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

async function makeHandler(
  rows: ScoreRow[],
  opts: { store?: PuzzleStore; rounds?: RoundStore } = {},
) {
  const profiles = memoryProfileStore();
  const friends = memoryFriendStore();
  const devices = memoryDeviceStore();
  const handler = createHandler({
    store: opts.store ?? emptyStore,
    now: () => NOW,
    scores: { scoreStore: fixedScores(rows) },
    profiles,
    friends,
    deviceStore: devices,
    devices: {
      turnstile: { verify: async () => true },
      allowSourceIp: true,
    },
    // The #206 playing rows read the friends' stored rounds through the round route's
    // own dep bundle; only `roundStore` is ever touched by the board.
    ...(opts.rounds
      ? {
          rounds: {
            roundStore: opts.rounds,
            scoreStore: fixedScores(rows),
            ipHmacSecret: 'secret',
            turnstile: { verify: async () => true },
            history: memoryHistoryStore(),
          },
        }
      : {}),
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
        return { live: true, profile: { publicId, name: 'Zoe', avatar: '' } };
      },
      create: async () => false,
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
    expect(global).toEqual({ rows: [], own: null, playing: [], waiting: [] });
    const caller = await seedDevice(devices);
    const mine = JSON.parse((await handler(post(QUERY, { token: caller.token }))).body) as Board;
    expect(mine).toEqual({ rows: [], own: null, playing: [], waiting: [] });
  });
});

// CONTRACT (#206): the friends board is alive mid-day. A friend with a stored round for
// the CURRENT published revision but no recorded score is IN PROGRESS — their row carries
// the EXACT deduped try count (`countTries` over the raw log against the day's full
// artifact, never the stored log's length) and the server-derived percentage, ordered by
// `orderPlaying` below every finished row. Friends only: the global board never carries a
// playing row. Sentence mode only: a Word run's log reaches the server at submission.
describe('board in-progress rows (#206)', () => {
  // Two holes whose maps share one surface family: `mer` and `mers` alias to ONE group in
  // the phare map and are unknown to the nuit map, so both resolve to the same guessKey
  // ("1|-1") and count as ONE try — the raw stored log length would say two.
  const ARTIFACT: Puzzle = {
    lang: 'fr',
    revision: 'f0e1d2c3b4a59687',
    words: ['le', 'phare', 'la', 'nuit'],
    holes: [
      { pos: 1, secret: { word: 'phare', slug: 'phare' }, start: { word: 'quai', slug: 'quai' }, start_rank: 2 },
      { pos: 3, secret: { word: 'nuit', slug: 'nuit' }, start: { word: 'soir', slug: 'soir' }, start_rank: 2 },
    ],
    ranks: {
      phare: {
        phare: { word: 'phare', rank: 0 },
        mer: { word: 'mer', rank: 1, dq: 255 },
        mers: { word: 'mer', rank: 1, dq: 255 },
        quai: { word: 'quai', rank: 2, dq: 128 },
      },
      nuit: {
        nuit: { word: 'nuit', rank: 0 },
        lune: { word: 'lune', rank: 1, dq: 255 },
        soir: { word: 'soir', rank: 2, dq: 128 },
      },
    },
  };
  const artifactStore: PuzzleStore = {
    getPuzzle: async (date, lang) => (date === DATE && lang === 'fr' ? ARTIFACT : null),
    getWordPuzzle: async () => null,
    getSlice: async () => null,
  };

  // Seed one player's stored round the way the round route writes it: the raw log plus
  // the derived summary, tagged with the revision it was played against.
  const seedRound = (
    rounds: RoundStore,
    publicId: string,
    guesses: string[],
    progress: number,
    over: { puzzle?: string; mode?: 'sentence' | 'word'; solved?: boolean } = {},
  ) =>
    rounds.append({
      date: DATE,
      lang: 'fr',
      mode: over.mode ?? 'sentence',
      publicId,
      guesses,
      puzzle: over.puzzle ?? ARTIFACT.revision,
      progress,
      solved: over.solved ?? false,
      now: NOW,
    });

  it('names mid-round friends in `playing` with the EXACT deduped try count', async () => {
    const me = generatePublicId();
    const finished = generatePublicId();
    const midRound = generatePublicId();
    const notYet = generatePublicId();
    const rounds = memoryRoundStore();
    const { handler, friends, profiles, devices } = await makeHandler(
      [{ publicId: finished, score: 4 }],
      { store: artifactStore, rounds },
    );
    for (const id of [finished, midRound, notYet]) {
      await friends.link({ publicId: me, friendId: id, createdAt: NOW.toISOString() });
    }
    // The finished friend's round row stays: the recorded score is the day's final word.
    await seedRound(rounds, finished, ['mer', 'lune', 'nuit', 'phare'], 100);
    // Three raw guesses, TWO tries: `mers` is `mer`'s own group in every map that knows
    // either, so the pair is one identity — the number the final score will land on.
    await seedRound(rounds, midRound, ['mer', 'mers', 'lune'], 62.5);
    // The caller's own live row shows too — it is where they stand among friends mid-day.
    await seedRound(rounds, me, ['quai'], 10);
    await profiles.upsert({ publicId: midRound, name: 'Zoe', avatar: 'A'.repeat(19), now: NOW.toISOString() });
    const caller = await callerOn(devices, me);

    const board = JSON.parse((await handler(post(QUERY, { token: caller.token }))).body) as Board;
    expect(board.rows.map((row) => row.publicId)).toEqual([finished]);
    expect(board.playing).toEqual([
      { publicId: midRound, tries: 2, progress: 62.5, name: 'Zoe', avatar: 'A'.repeat(19) },
      { publicId: me, tries: 1, progress: 10, name: '', avatar: null },
    ]);
    // A playing friend is never ALSO "not played yet".
    expect(board.waiting.map((row) => row.publicId)).toEqual([notYet]);
  });

  it("orders playing rows by the shared rule: progress down, tries up, id last", async () => {
    const me = generatePublicId();
    const ids = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'];
    const rounds = memoryRoundStore();
    const { handler, friends, devices } = await makeHandler([], {
      store: artifactStore,
      rounds,
    });
    for (const id of ids) {
      await friends.link({ publicId: me, friendId: id, createdAt: NOW.toISOString() });
    }
    await seedRound(rounds, ids[0], ['quai'], 40); // behind on progress
    await seedRound(rounds, ids[1], ['mer', 'lune'], 80); // same progress, more tries
    await seedRound(rounds, ids[2], ['soir'], 80);
    const caller = await callerOn(devices, me);

    const board = JSON.parse((await handler(post(QUERY, { token: caller.token }))).body) as Board;
    expect(board.playing.map((row) => [row.publicId, row.progress, row.tries])).toEqual([
      [ids[2], 80, 1],
      [ids[1], 80, 2],
      [ids[0], 40, 1],
    ]);
  });

  it('reads a round for a RETIRED revision as not started for THIS puzzle', async () => {
    const me = generatePublicId();
    const friend = generatePublicId();
    const rounds = memoryRoundStore();
    const { handler, friends, devices } = await makeHandler([], {
      store: artifactStore,
      rounds,
    });
    await friends.link({ publicId: me, friendId: friend, createdAt: NOW.toISOString() });
    // A log played against a republished-away version: its tries would dedup against
    // maps it was never played on, and the round restarts on its player's next append.
    await seedRound(rounds, friend, ['mer'], 50, { puzzle: 'deadbeefdeadbeef' });
    const caller = await callerOn(devices, me);

    const board = JSON.parse((await handler(post(QUERY, { token: caller.token }))).body) as Board;
    expect(board.playing).toEqual([]);
    expect(board.waiting.map((row) => row.publicId)).toEqual([friend]);
  });

  // ACCEPTED (user-decided 2026-08-26, on review; the fourth state is #224): what the
  // route subtracts is the players the population RANKS, which is not the players who are
  // DONE. A round can END with no score row three ways — capped at ROUND_GUESS_CAP (#214),
  // solved past the 22:00 flip (#211's `onTime`), or solved with its row refused by the
  // #169 IP allowance — and all three keep their derived summary on the round item, so the
  // board carries them under IN PROGRESS for the rest of the day. Pinned because it looks
  // like a bug and is not one: the numbers on the row are the player's real ones, where
  // the cheap fix would file a 500-guess round or an actual solve under "not played yet".
  it('keeps a round that ENDED with no recorded score in `playing` (#224)', async () => {
    const me = generatePublicId();
    const solvedUnranked = generatePublicId();
    const capped = generatePublicId();
    const rounds = memoryRoundStore();
    const { handler, friends, devices } = await makeHandler([], { store: artifactStore, rounds });
    for (const id of [solvedUnranked, capped]) {
      await friends.link({ publicId: me, friendId: id, createdAt: NOW.toISOString() });
    }
    // SOLVED, but the population holds no row for them — the IP allowance refused it, or
    // the solve landed past the flip. `recordScoreRow` swallows both silently by design.
    await seedRound(rounds, solvedUnranked, ['phare', 'nuit'], 100, { solved: true });
    // CAPPED: ROUND_GUESS_CAP raw misses, unsolved, terminal at infinity. Every miss keys
    // as itself, so the exact try count is the whole cap.
    const misses = Array.from({ length: ROUND_GUESS_CAP }, (_, i) => `rate${i}`);
    await seedRound(rounds, capped, misses, 25);
    const caller = await callerOn(devices, me);

    const board = JSON.parse((await handler(post(QUERY, { token: caller.token }))).body) as Board;
    expect(board.rows).toEqual([]);
    expect(board.playing.map((row) => [row.publicId, row.progress, row.tries])).toEqual([
      [solvedUnranked, 100, 2],
      [capped, 25, ROUND_GUESS_CAP],
    ]);
    // And neither is ever ALSO "not played yet" — the one claim this section refuses.
    expect(board.waiting).toEqual([]);
  });

  it('carries no playing section in Word mode or on the global board', async () => {
    const me = generatePublicId();
    const friend = generatePublicId();
    const rounds = memoryRoundStore();
    const { handler, friends, devices } = await makeHandler([{ publicId: me, score: 3 }], {
      store: artifactStore,
      rounds,
    });
    await friends.link({ publicId: me, friendId: friend, createdAt: NOW.toISOString() });
    await seedRound(rounds, friend, ['mer'], 50);
    await seedRound(rounds, friend, ['mer'], 50, { mode: 'word' });
    const caller = await callerOn(devices, me);

    // Word mode: a run's log reaches the server only at submission — nothing to read.
    const word = JSON.parse(
      (await handler(post({ ...QUERY, mode: 'word' }, { token: caller.token }))).body,
    ) as Board;
    expect(word.playing).toEqual([]);
    expect(word.waiting.map((row) => row.publicId)).toEqual([friend]);

    // The global board never watches anyone play — friends only, by consent.
    const global = JSON.parse((await handler(get({ ...QUERY, id: me }))).body) as Board;
    expect(global.playing).toEqual([]);
  });

  it('answers an UNPUBLISHED day with no playing section (no artifact, no rounds)', async () => {
    const me = generatePublicId();
    const friend = generatePublicId();
    const rounds = memoryRoundStore();
    const { handler, friends, devices } = await makeHandler([], { rounds });
    await friends.link({ publicId: me, friendId: friend, createdAt: NOW.toISOString() });
    const caller = await callerOn(devices, me);

    const board = JSON.parse((await handler(post(QUERY, { token: caller.token }))).body) as Board;
    expect(board.playing).toEqual([]);
    expect(board.waiting.map((row) => row.publicId)).toEqual([friend]);
  });
});
