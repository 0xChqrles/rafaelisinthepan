import { describe, expect, it, vi } from 'vitest';
import { activeDate, anonName, generatePublicId, ROUND_GUESS_CAP, type Puzzle } from '@whippin/shared';
import { farGuesses, readBotRounds, type BotRoundsDeps } from './botRounds';
import { memoryGroupStore } from './memoryGroupStore';
import { memoryProfileStore } from './memoryProfileStore';
import { memoryRoundStore } from './memoryRoundStore';
import type { RoundStore } from './roundStore';
import { buildSlice } from './slice';
import type { PuzzleStore } from './store';

// CONTRACT (root AGENTS.md, shared `botRounds.ts`): the bot's read of a Whippin group's
// rounds. What is asserted is the SPOILER RULE — a guess leaves only when, for EVERY secret,
// it is unranked or ranked strictly farther than that secret's start word — plus the
// members-only read, the countTries dedup of the try index, and the current-revision rule.

const NOW = new Date('2026-10-30T12:00:00Z');
const DATE = activeDate(NOW);
const GROUP = 'gggggggggggggggg';

// Two secrets, start ranks 3 and 2; `phare` appears in two holes sharing one start.
//   rive  — phare rank 4 (> 3), unranked in nuit         -> FAR
//   quai  — phare rank 3 (= start)                        -> near, never emitted
//   ombre — phare rank 9 (far), nuit rank 1 (near)        -> near in ONE map, never emitted
//   aube  — phare rank 5, nuit rank 4 (both far)          -> FAR, closest group's display
//   mers  — `mer`'s alias, phare rank 1                    -> near
const ARTIFACT: Puzzle = {
  lang: 'fr',
  revision: 'abc123',
  words: ['le', 'phare', 'et', 'le', 'phare', 'la', 'nuit'],
  holes: [
    { pos: 1, secret: { word: 'phare', slug: 'phare' }, start: { word: 'quai', slug: 'quai' }, start_rank: 3 },
    { pos: 4, secret: { word: 'phare', slug: 'phare' }, start: { word: 'quai', slug: 'quai' }, start_rank: 3 },
    { pos: 6, secret: { word: 'nuit', slug: 'nuit' }, start: { word: 'soir', slug: 'soir' }, start_rank: 2 },
  ],
  ranks: {
    phare: {
      phare: { word: 'phare', rank: 0 },
      mer: { word: 'mer', rank: 1, dq: 255 },
      mers: { word: 'mer', rank: 1, dq: 255 },
      quai: { word: 'quai', rank: 3, dq: 200 },
      rive: { word: 'rive', rank: 4, dq: 150 },
      rives: { word: 'rive', rank: 4, dq: 150 },
      aube: { word: 'aube', rank: 5, dq: 100 },
      ombre: { word: 'ombre', rank: 9, dq: 0 },
    },
    nuit: {
      nuit: { word: 'nuit', rank: 0 },
      ombre: { word: 'ombre', rank: 1, dq: 255 },
      soir: { word: 'soir', rank: 2, dq: 128 },
      aube: { word: 'aubé', rank: 4, dq: 0 },
    },
  },
};

function artifactStore(puzzle: Puzzle | null = ARTIFACT): PuzzleStore {
  const today = (date: string, lang: string) => puzzle !== null && date === DATE && lang === 'fr';
  return {
    getPuzzle: async (date, lang) => (today(date, lang) ? puzzle : null),
    hasPuzzle: async (date, lang) => today(date, lang),
    getSlice: async (date, lang) => (today(date, lang) ? buildSlice(puzzle!) : null),
  };
}

const seedRound = (
  rounds: RoundStore,
  publicId: string,
  guesses: string[],
  opts: { puzzle?: string; solved?: boolean; progress?: number } = {},
) =>
  rounds.append({
    date: DATE,
    lang: 'fr',
    publicId,
    guesses,
    puzzle: opts.puzzle ?? ARTIFACT.revision,
    progress: opts.progress ?? 0,
    solved: opts.solved ?? false,
    now: NOW,
  });

async function setup(opts: { puzzle?: Puzzle | null; gone?: readonly string[] } = {}) {
  const groups = memoryGroupStore();
  const profiles = memoryProfileStore((id) => !opts.gone?.includes(id));
  const rounds = memoryRoundStore();
  // `undefined` takes the store's default artifact; `null` is an unpublished day.
  const deps: BotRoundsDeps = { groups, profiles, rounds, puzzles: artifactStore(opts.puzzle) };
  const owner = generatePublicId();
  await groups.create({ id: GROUP, name: 'Famille', createdBy: owner, now: NOW.toISOString() });
  return { deps, groups, profiles, rounds, owner };
}

const ask = (deps: BotRoundsDeps, over: Record<string, unknown> = {}) =>
  readBotRounds(deps, { group: GROUP, lang: 'fr', date: DATE, ...over }, NOW);

describe('farGuesses — the spoiler rule', () => {
  it('never emits the secret nor any guess at or inside a start rank', () => {
    const far = farGuesses(ARTIFACT, ['phare', 'nuit', 'mer', 'quai', 'soir']);
    expect(far).toEqual([]);
  });

  it('emits a guess one rank past the start, with its closest group display', () => {
    expect(farGuesses(ARTIFACT, ['rive'])).toEqual([{ try: 1, word: 'rive' }]);
  });

  it('withholds a word far in one map but near in another', () => {
    expect(farGuesses(ARTIFACT, ['ombre'])).toEqual([]);
  });

  it('names a word far everywhere by its CLOSEST group', () => {
    // nuit ranks it 4 (`aubé`), phare 5 (`aube`): the closer map's display wins.
    expect(farGuesses(ARTIFACT, ['aube'])).toEqual([{ try: 1, word: 'aubé' }]);
  });

  it('emits misses as the folded string', () => {
    expect(farGuesses(ARTIFACT, ['zzz'])).toEqual([{ try: 1, word: 'zzz' }]);
    // A key every object inherits is still a miss, never an entry with no word.
    expect(farGuesses(ARTIFACT, ['constructor', 'tostring'])).toEqual([
      { try: 1, word: 'constructor' },
      { try: 2, word: 'tostring' },
    ]);
  });

  it('numbers tries like countTries: near tries count, duplicates and aliases do not', () => {
    const far = farGuesses(ARTIFACT, ['mer', 'rive', 'mers', 'zzz', 'rives', 'zzz', 'quai', 'aube']);
    // Unique tries: mer(1) rive(2) zzz(3) quai(4) aube(5) — `mers`/`rives`/`zzz` repeat.
    // Oddest first: the miss, then rank 4 twice, the earlier try first.
    expect(far).toEqual([
      { try: 3, word: 'zzz' },
      { try: 2, word: 'rive' },
      { try: 5, word: 'aubé' },
    ]);
  });

  it('hands the words back ODDEST FIRST: misses, then the farthest rank, ties by the earlier try', () => {
    // Closest ranks: rive 4, aube 4 (via nuit), plus a far word at 9 in both maps.
    const wide: Puzzle = {
      ...ARTIFACT,
      ranks: {
        phare: { ...ARTIFACT.ranks.phare, loin: { word: 'loin', rank: 9, dq: 0 } },
        nuit: { ...ARTIFACT.ranks.nuit, loin: { word: 'loin', rank: 9, dq: 0 } },
      },
    };
    const far = farGuesses(wide, ['aube', 'rive', 'loin', 'zzz', 'yyy']);
    expect(far).toEqual([
      { try: 4, word: 'zzz' },
      { try: 5, word: 'yyy' },
      { try: 3, word: 'loin' },
      { try: 1, word: 'aubé' },
      { try: 2, word: 'rive' },
    ]);
  });

  it('never lets a rank leave: every guess carries exactly try and word', () => {
    const far = farGuesses(ARTIFACT, ['rive', 'zzz', 'aube', 'mer', 'constructor']);
    expect(far.length).toBeGreaterThan(0);
    for (const guess of far) expect(Object.keys(guess).sort()).toEqual(['try', 'word']);
  });

  it('fails closed on a ranked map whose secret no hole names', () => {
    const odd: Puzzle = { ...ARTIFACT, ranks: { ...ARTIFACT.ranks, ghost: { rive: { word: 'rive', rank: 900, dq: 0 } } } };
    expect(farGuesses(odd, ['rive'])).toEqual([]);
  });
});

describe('readBotRounds', () => {
  it('answers every member: started rows from the current revision, the rest not started', async () => {
    const { deps, groups, profiles, rounds, owner } = await setup();
    const named = generatePublicId();
    const idle = generatePublicId();
    // Joined after the owner, one second apart: the face lists oldest membership first.
    for (const [i, id] of [named, idle].entries()) {
      await groups.join({ id: GROUP, publicId: id, now: new Date(NOW.getTime() + (i + 1) * 1000).toISOString() });
    }
    await profiles.upsert({ publicId: named, name: 'Zoe', avatar: '', now: NOW.toISOString() });
    await seedRound(rounds, owner, ['rive', 'mer', 'phare', 'nuit'], { progress: 100, solved: true });
    await seedRound(rounds, named, ['zzz', 'quai'], { progress: 40 });

    const answer = await ask(deps);
    expect(answer).toEqual({
      ok: true,
      group: { id: GROUP, name: 'Famille' },
      revision: 'abc123',
      members: [
        {
          publicId: owner,
          name: anonName(owner),
          started: true,
          tries: 4,
          progress: 100,
          solved: true,
          gaveUp: false,
          over: false,
          farGuesses: [{ try: 1, word: 'rive' }],
        },
        {
          publicId: named,
          name: 'Zoe',
          started: true,
          tries: 2,
          progress: 40,
          solved: false,
          gaveUp: false,
          over: false,
          farGuesses: [{ try: 1, word: 'zzz' }],
        },
        {
          publicId: idle,
          name: anonName(idle),
          started: false,
          tries: 0,
          progress: 0,
          solved: false,
          gaveUp: false,
          over: false,
          farGuesses: [],
        },
      ],
    });
  });

  it('marks a given-up or capped round over', async () => {
    const { deps, rounds, owner } = await setup();
    await seedRound(rounds, owner, ['rive']);
    await rounds.giveUp({ date: DATE, lang: 'fr', publicId: owner, puzzle: ARTIFACT.revision });
    const answer = await ask(deps);
    expect(answer.ok && answer.members[0]).toMatchObject({ started: true, gaveUp: true, over: true });

    const capped = await setup();
    const log = Array.from({ length: ROUND_GUESS_CAP }, (_, i) => `miss${i}`);
    await seedRound(capped.rounds, capped.owner, log);
    const cappedAnswer = await ask(capped.deps);
    expect(cappedAnswer.ok && cappedAnswer.members[0]).toMatchObject({ over: true, gaveUp: false });
  });

  it('treats a retired revision row as not started', async () => {
    const { deps, rounds, owner } = await setup();
    await seedRound(rounds, owner, ['rive', 'zzz'], { puzzle: 'old999' });
    const answer = await ask(deps);
    expect(answer.ok && answer.members[0]).toMatchObject({ started: false, tries: 0, farGuesses: [] });
  });

  it('answers revision null and nobody started on an unpublished day', async () => {
    const { deps, rounds, owner } = await setup({ puzzle: null });
    await seedRound(rounds, owner, ['rive']);
    const answer = await ask(deps);
    expect(answer).toMatchObject({ ok: true, revision: null, members: [{ publicId: owner, started: false }] });
  });

  it('reads the rounds of the group members only, gone accounts dropped', async () => {
    const { deps, groups, rounds, owner } = await setup();
    const member = generatePublicId();
    const stranger = generatePublicId();
    await groups.join({ id: GROUP, publicId: member, now: NOW.toISOString() });
    await seedRound(rounds, stranger, ['rive']);
    const getMany = vi.spyOn(rounds, 'getMany');
    const answer = await ask(deps);
    expect(getMany).toHaveBeenCalledTimes(1);
    expect([...getMany.mock.calls[0][1]].sort()).toEqual([owner, member].sort());
    expect(answer.ok && answer.members.map((m) => m.publicId)).not.toContain(stranger);

    const ghost = generatePublicId();
    const goneCase = await setup({ gone: [ghost] });
    await goneCase.groups.join({ id: GROUP, publicId: ghost, now: NOW.toISOString() });
    const spy = vi.spyOn(goneCase.rounds, 'getMany');
    const goneAnswer = await ask(goneCase.deps);
    expect(spy.mock.calls[0][1]).toEqual([goneCase.owner]);
    expect(goneAnswer.ok && goneAnswer.members.map((m) => m.publicId)).toEqual([goneCase.owner]);
  });

  it('answers unknown_group for a group that does not exist', async () => {
    const { deps } = await setup();
    expect(await ask(deps, { group: 'hhhhhhhhhhhhhhhh' })).toEqual({ ok: false, error: 'unknown_group' });
  });

  it('answers bad_request for a malformed request, never throwing', async () => {
    const { deps } = await setup();
    const tomorrow = new Date(NOW.getTime() + 2 * 86_400_000);
    for (const event of [
      null,
      'x',
      42,
      {},
      { group: GROUP, lang: 'fr' },
      { group: 'NOT-A-GROUP', lang: 'fr', date: DATE },
      { group: GROUP, lang: 'de', date: DATE },
      { group: GROUP, lang: 'constructor', date: DATE },
      { group: GROUP, lang: 'fr', date: '2026-02-30' },
      { group: GROUP, lang: 'fr', date: 'bonus/1234567' },
      { group: GROUP, lang: 'fr', date: activeDate(tomorrow) },
    ]) {
      expect(await readBotRounds(deps, event, NOW)).toEqual({ ok: false, error: 'bad_request' });
    }
  });

  it('serves a past day', async () => {
    const { deps } = await setup();
    expect(await ask(deps, { date: '2026-10-01' })).toMatchObject({ ok: true, revision: null });
  });
});
