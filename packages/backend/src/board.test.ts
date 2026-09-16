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
import { memoryGroupStore } from './memoryGroupStore';
import { memoryHistoryStore } from './memoryHistoryStore';
import { memoryProfileStore } from './memoryProfileStore';
import { memoryRoundStore } from './memoryRoundStore';
import type { FnUrlEvent } from './respond';
import type { RoundStore } from './roundStore';
import type { ScoreRow, ScoreStore } from './scoreStore';
import type { PuzzleStore } from './store';
import { seedDevice } from './testDevice';

// The /board route (#190): the GLOBAL top-50 read (anonymous GET) and a GROUP's boards
// (authenticated POST, #271). The ranking rules themselves are contract-tested in
// @whippin/shared/leaderboard.test.ts; what this asserts is the ROUTE — params, auth,
// membership, and the response carrying ranks + profiles the way a board renders them —
// plus the #206 in-progress rows: a member with a stored round but no recorded score is
// PLAYING, with the EXACT deduped try count (against the day's full artifact) and the
// stored derived percentage, on the day POST only.

const NOW = new Date('2026-08-19T12:00:00Z');
const DATE = activeDate(NOW);

const emptyStore: PuzzleStore = {
  getPuzzle: async () => null,
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
  const devices = memoryDeviceStore();
  const groups = memoryGroupStore();
  const handler = createHandler({
    store: opts.store ?? emptyStore,
    now: () => NOW,
    scores: { scoreStore: fixedScores(rows) },
    profiles,
    groups,
    deviceStore: devices,
    devices: {
      turnstile: { verify: async () => true },
      allowSourceIp: true,
    },
    // The #206 playing rows read the members' stored rounds through the round route's
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
  return { handler, profiles, groups, devices };
}

// The caller's device, seeded on an account the test already named — the group face
// resolves the caller from the token, so the board it answers is that ACCOUNT's.
const callerOn = (devices: ReturnType<typeof memoryDeviceStore>, accountId: string) =>
  seedDevice(devices, { accountId });

// ONE group per test, created by the caller and joined by whoever the case names — the
// shape every trusted-board case needs. Ids here are not seeded accounts, so the store is
// built without an account check (the route's own membership check is what is asserted).
const GROUP = 'gggggggggggggggg';
async function enroll(groups: ReturnType<typeof memoryGroupStore>, me: string, ...others: string[]) {
  if (!(await groups.get(GROUP))) {
    await groups.create({ id: GROUP, name: 'Test', createdBy: me, now: NOW.toISOString() });
  }
  for (const id of others) await groups.join({ id: GROUP, publicId: id, now: NOW.toISOString() });
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

const QUERY = { lang: 'fr', date: DATE };

describe('board route (#190)', () => {
  it('rejects a missing/unsupported lang and date (protocol violations)', async () => {
    const { handler } = await makeHandler([]);
    expect((await handler(get({ date: DATE }))).statusCode).toBe(400);
    expect((await handler(get({ lang: 'de', date: DATE }))).statusCode).toBe(400);
    // The support check must be an OWN-property check: `map[lang] === undefined` walks
    // the prototype chain, so Object.prototype keys would pass as "languages" and reach
    // the store key. /scores is masked by its puzzle-store 404; /board reads no puzzle
    // store, so the hole would be reachable to a 200 here.
    for (const lang of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect((await handler(get({ lang, date: DATE }))).statusCode).toBe(400);
    }
    expect((await handler(get({ lang: 'fr' }))).statusCode).toBe(400);
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

  it('answers a group board only for its members', async () => {
    const me = generatePublicId();
    const friend = generatePublicId();
    const stranger = generatePublicId();
    const { handler, groups, devices } = await makeHandler([
      { publicId: me, score: 9 },
      { publicId: friend, score: 4 },
      { publicId: stranger, score: 1 },
    ]);
    await enroll(groups, me, friend);
    const caller = await callerOn(devices, me);

    const result = await handler(post(QUERY, { token: caller.token, group: GROUP }));
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
      groups: memoryGroupStore(),
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

  it("shows members' scores before the caller has played (own row simply absent)", async () => {
    const me = generatePublicId();
    const friend = generatePublicId();
    const { handler, groups, devices } = await makeHandler([{ publicId: friend, score: 4 }]);
    await enroll(groups, me, friend);
    const caller = await callerOn(devices, me);

    const board = JSON.parse((await handler(post(QUERY, { token: caller.token, group: GROUP }))).body) as Board;
    expect(board.rows.map((row) => row.publicId)).toEqual([friend]);
    // The caller never waits on their own board — the identity strip already shows them.
    expect(board.waiting).toEqual([]);
  });

  it('names a member with no score today in `waiting` instead of dropping them', async () => {
    const me = generatePublicId();
    const played = generatePublicId();
    const notYet = generatePublicId();
    const { handler, groups, profiles, devices } = await makeHandler([
      { publicId: me, score: 9 },
      { publicId: played, score: 4 },
    ]);
    await enroll(groups, me, played);
    await enroll(groups, me, notYet);
    await profiles.upsert({ publicId: notYet, name: 'Later', avatar: 'A'.repeat(19), now: NOW.toISOString() });
    const caller = await callerOn(devices, me);

    const board = JSON.parse((await handler(post(QUERY, { token: caller.token, group: GROUP }))).body) as Board;
    expect(board.rows.map((row) => row.publicId)).toEqual([played, me]);
    expect(board.waiting).toEqual([
      { publicId: notYet, name: 'Later', avatar: 'A'.repeat(19) },
    ]);
  });

  it('refuses a group read without a canonical device token (the auth IS the body)', async () => {
    const { handler } = await makeHandler([]);
    expect((await handler(post(QUERY, { group: GROUP }))).statusCode).toBe(400);
    expect((await handler(post(QUERY, { token: 'nope', group: GROUP }))).statusCode).toBe(400);
    // Well-formed but never issued: the distinct answer that signs a device out (#216).
    const stranger = await handler(post(QUERY, { token: 'f'.repeat(64), group: GROUP }));
    expect(stranger.statusCode).toBe(401);
    expect(JSON.parse(stranger.body).error).toBe('unknown_device');
  });

  it('answers an empty day honestly on both faces', async () => {
    const { handler, groups, devices } = await makeHandler([]);
    const global = JSON.parse((await handler(get(QUERY))).body) as Board;
    expect(global).toEqual({ rows: [], own: null, playing: [], waiting: [] });
    const caller = await seedDevice(devices);
    await enroll(groups, caller.accountId);
    const mine = JSON.parse((await handler(post(QUERY, { token: caller.token, group: GROUP }))).body) as Board;
    expect(mine).toEqual({ rows: [], own: null, playing: [], waiting: [] });
  });

  // THE TRUST BOUNDARY (#271): a board is drawn over a member list, for a member only.
  it('refuses a group the caller is not in, and a group that does not exist, alike', async () => {
    const me = generatePublicId();
    const other = generatePublicId();
    const { handler, groups, devices } = await makeHandler([{ publicId: other, score: 3 }]);
    await enroll(groups, other);
    const caller = await callerOn(devices, me);
    const outsider = await handler(post(QUERY, { token: caller.token, group: GROUP }));
    expect(outsider.statusCode).toBe(403);
    expect(JSON.parse(outsider.body).error).toBe('not_member');
    const nowhere = await handler(post(QUERY, { token: caller.token, group: 'nnnnnnnnnnnnnnnn' }));
    expect(nowhere.statusCode).toBe(403);
    expect((await handler(post(QUERY, { token: caller.token, group: 'NOPE' }))).statusCode).toBe(400);
    expect((await handler(post(QUERY, { token: caller.token }))).statusCode).toBe(400);
    expect(
      (await handler(post(QUERY, { token: caller.token, group: GROUP, period: 'year' }))).statusCode,
    ).toBe(400);
  });
});

// The PERIOD boards (#271): the shared `rankPeriod` rule over every member's recorded score
// on every day `periodRange` names, and the STANDING read the solved screen makes.
describe('group period boards and the standing (#271)', () => {
  // The day partitions BY DATE: a score store the route reads one day at a time.
  function datedScores(rows: (ScoreRow & { date: string })[]): ScoreStore {
    return {
      list: async (key) => rows.filter((row) => row.date === key.date),
      getMany: async (key, ids) =>
        rows.filter((row) => row.date === key.date && ids.includes(row.publicId)),
      submit: async () => {
        throw new Error('the board route never submits');
      },
    };
  }
  async function makeDated(rows: (ScoreRow & { date: string })[]) {
    const profiles = memoryProfileStore();
    const devices = memoryDeviceStore();
    const groups = memoryGroupStore();
    const handler = createHandler({
      store: emptyStore,
      now: () => NOW,
      scores: { scoreStore: datedScores(rows) },
      profiles,
      groups,
      deviceStore: devices,
      devices: { turnstile: { verify: async () => true }, allowSourceIp: true },
    });
    return { handler, profiles, groups, devices };
  }
  // NOW is 2026-08-19, a Wednesday: the week is 08-17 .. 08-19, the month 08-01 .. 08-19.
  const ME = 'aaaaaaaaaaaaaaaa';
  const B = 'bbbbbbbbbbbbbbbb';
  const C = 'cccccccccccccccc';
  const OUTSIDE = 'zzzzzzzzzzzzzzzz';

  it('ranks the WEEK by podium points over the week days only, members only', async () => {
    const { handler, groups, devices, profiles } = await makeDated([
      { date: '2026-08-17', publicId: ME, score: 5 },
      { date: '2026-08-17', publicId: B, score: 3 },
      { date: '2026-08-18', publicId: ME, score: 4 },
      { date: '2026-08-19', publicId: B, score: 9 },
      { date: '2026-08-19', publicId: ME, score: 9 },
      // Last week, and a stranger: neither counts.
      { date: '2026-08-16', publicId: B, score: 1 },
      { date: '2026-08-18', publicId: OUTSIDE, score: 1 },
    ]);
    await enroll(groups, ME, B, C);
    await profiles.upsert({ publicId: B, name: 'Bea', avatar: 'A'.repeat(19), now: NOW.toISOString() });
    const caller = await callerOn(devices, ME);
    const result = await handler(post(QUERY, { token: caller.token, group: GROUP, period: 'week' }));
    expect(result.statusCode).toBe(200);
    const board = JSON.parse(result.body);
    expect(board.from).toBe('2026-08-17');
    expect(board.to).toBe(DATE);
    // Day 17: B first (3), ME second (2). Day 18: ME alone (3). Day 19: tie, both 3.
    expect(board.rows).toEqual([
      { publicId: ME, rank: 1, points: 8, solvedDays: 3, total: 18, name: '', avatar: null },
      { publicId: B, rank: 2, points: 6, solvedDays: 2, total: 12, name: 'Bea', avatar: 'A'.repeat(19) },
    ]);
  });

  it('ranks the MONTH from the first of the month to the day asked about', async () => {
    const { handler, groups, devices } = await makeDated([
      { date: '2026-08-02', publicId: B, score: 2 },
      { date: '2026-07-31', publicId: ME, score: 2 },
    ]);
    await enroll(groups, ME, B);
    const caller = await callerOn(devices, ME);
    const board = JSON.parse(
      (await handler(post(QUERY, { token: caller.token, group: GROUP, period: 'month' }))).body,
    );
    expect(board.from).toBe('2026-08-01');
    expect(board.rows.map((row: { publicId: string }) => row.publicId)).toEqual([B]);
  });

  it('answers the standing in each of the caller\'s groups, and none where they have no row', async () => {
    const { handler, groups, devices } = await makeDated([
      { date: DATE, publicId: ME, score: 7 },
      { date: DATE, publicId: B, score: 3 },
      { date: DATE, publicId: C, score: 7 },
    ]);
    await enroll(groups, ME, B, C);
    await groups.create({ id: 'hhhhhhhhhhhhhhhh', name: 'Duo', createdBy: B, now: NOW.toISOString() });
    await groups.join({ id: 'hhhhhhhhhhhhhhhh', publicId: ME, now: NOW.toISOString() });
    await groups.create({ id: 'iiiiiiiiiiiiiiii', name: 'Solo', createdBy: ME, now: NOW.toISOString() });
    const caller = await callerOn(devices, ME);
    const result = await handler(post(QUERY, { token: caller.token, standing: true }));
    expect(result.statusCode).toBe(200);
    // Tied with C behind B in the big group; second of two in the duo; alone in Solo.
    expect(JSON.parse(result.body).standings).toEqual([
      { group: GROUP, rank: 2, of: 3 },
      { group: 'hhhhhhhhhhhhhhhh', rank: 2, of: 2 },
      { group: 'iiiiiiiiiiiiiiii', rank: 1, of: 1 },
    ]);
    // A caller with no row today stands nowhere.
    const late = await callerOn(devices, 'dddddddddddddddd');
    await groups.join({ id: GROUP, publicId: 'dddddddddddddddd', now: NOW.toISOString() });
    expect(JSON.parse((await handler(post(QUERY, { token: late.token, standing: true }))).body)).toEqual({
      standings: [],
    });
    expect(
      (await handler(post(QUERY, { token: caller.token, standing: true, group: GROUP }))).statusCode,
    ).toBe(400);
  });
});

// CONTRACT (#206): a group's day board is alive mid-day. A member with a stored round for
// the CURRENT published revision but no recorded score is IN PROGRESS — their row carries
// the EXACT deduped try count (`countTries` over the raw log against the day's full
// artifact, never the stored log's length) and the server-derived percentage, ordered by
// `orderPlaying` below every finished row. Friends only: the global board never carries a
// playing row.
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
    getSlice: async () => null,
  };

  // Seed one player's stored round the way the round route writes it: the raw log plus
  // the derived summary, tagged with the revision it was played against.
  const seedRound = (
    rounds: RoundStore,
    publicId: string,
    guesses: string[],
    progress: number,
    over: { puzzle?: string; solved?: boolean } = {},
  ) =>
    rounds.append({
      date: DATE,
      lang: 'fr',
      publicId,
      guesses,
      puzzle: over.puzzle ?? ARTIFACT.revision,
      progress,
      solved: over.solved ?? false,
      early: false,
      now: NOW,
    });

  it('names mid-round members in `playing` with the EXACT deduped try count', async () => {
    const me = generatePublicId();
    const finished = generatePublicId();
    const midRound = generatePublicId();
    const notYet = generatePublicId();
    const rounds = memoryRoundStore();
    const { handler, groups, profiles, devices } = await makeHandler(
      [{ publicId: finished, score: 4 }],
      { store: artifactStore, rounds },
    );
    for (const id of [finished, midRound, notYet]) {
      await enroll(groups, me, id);
    }
    // The finished friend's round row stays: the recorded score is the day's final word.
    await seedRound(rounds, finished, ['mer', 'lune', 'nuit', 'phare'], 100);
    // Three raw guesses, TWO tries: `mers` is `mer`'s own group in every map that knows
    // either, so the pair is one identity — the number the final score will land on.
    await seedRound(rounds, midRound, ['mer', 'mers', 'lune'], 62.5);
    // The caller's own live row shows too — it is where they stand among the group mid-day.
    await seedRound(rounds, me, ['quai'], 10);
    await profiles.upsert({ publicId: midRound, name: 'Zoe', avatar: 'A'.repeat(19), now: NOW.toISOString() });
    const caller = await callerOn(devices, me);

    const board = JSON.parse((await handler(post(QUERY, { token: caller.token, group: GROUP }))).body) as Board;
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
    const { handler, groups, devices } = await makeHandler([], {
      store: artifactStore,
      rounds,
    });
    for (const id of ids) {
      await enroll(groups, me, id);
    }
    await seedRound(rounds, ids[0], ['quai'], 40); // behind on progress
    await seedRound(rounds, ids[1], ['mer', 'lune'], 80); // same progress, more tries
    await seedRound(rounds, ids[2], ['soir'], 80);
    const caller = await callerOn(devices, me);

    const board = JSON.parse((await handler(post(QUERY, { token: caller.token, group: GROUP }))).body) as Board;
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
    const { handler, groups, devices } = await makeHandler([], {
      store: artifactStore,
      rounds,
    });
    await enroll(groups, me, friend);
    // A log played against a republished-away version: its tries would dedup against
    // maps it was never played on, and the round restarts on its player's next append.
    await seedRound(rounds, friend, ['mer'], 50, { puzzle: 'deadbeefdeadbeef' });
    const caller = await callerOn(devices, me);

    const board = JSON.parse((await handler(post(QUERY, { token: caller.token, group: GROUP }))).body) as Board;
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
    const { handler, groups, devices } = await makeHandler([], { store: artifactStore, rounds });
    for (const id of [solvedUnranked, capped]) {
      await enroll(groups, me, id);
    }
    // SOLVED, but the population holds no row for them — the IP allowance refused it, or
    // the solve landed past the flip. `recordScoreRow` swallows both silently by design.
    await seedRound(rounds, solvedUnranked, ['phare', 'nuit'], 100, { solved: true });
    // CAPPED: ROUND_GUESS_CAP raw misses, unsolved, terminal at infinity. Every miss keys
    // as itself, so the exact try count is the whole cap.
    const misses = Array.from({ length: ROUND_GUESS_CAP }, (_, i) => `rate${i}`);
    await seedRound(rounds, capped, misses, 25);
    const caller = await callerOn(devices, me);

    const board = JSON.parse((await handler(post(QUERY, { token: caller.token, group: GROUP }))).body) as Board;
    expect(board.rows).toEqual([]);
    expect(board.playing.map((row) => [row.publicId, row.progress, row.tries])).toEqual([
      [solvedUnranked, 100, 2],
      [capped, 25, ROUND_GUESS_CAP],
    ]);
    // And neither is ever ALSO "not played yet" — the one claim this section refuses.
    expect(board.waiting).toEqual([]);
  });

  it('carries no playing section on the global board', async () => {
    const me = generatePublicId();
    const friend = generatePublicId();
    const rounds = memoryRoundStore();
    const { handler, groups } = await makeHandler([{ publicId: me, score: 3 }], {
      store: artifactStore,
      rounds,
    });
    await enroll(groups, me, friend);
    await seedRound(rounds, friend, ['mer'], 50);

    // The global board never watches anyone play — members only, by consent.
    const global = JSON.parse((await handler(get({ ...QUERY, id: me }))).body) as Board;
    expect(global.playing).toEqual([]);
  });

  it('answers an UNPUBLISHED day with no playing section (no artifact, no rounds)', async () => {
    const me = generatePublicId();
    const friend = generatePublicId();
    const rounds = memoryRoundStore();
    const { handler, groups, devices } = await makeHandler([], { rounds });
    await enroll(groups, me, friend);
    const caller = await callerOn(devices, me);

    const board = JSON.parse((await handler(post(QUERY, { token: caller.token, group: GROUP }))).body) as Board;
    expect(board.playing).toEqual([]);
    expect(board.waiting.map((row) => row.publicId)).toEqual([friend]);
  });
});
