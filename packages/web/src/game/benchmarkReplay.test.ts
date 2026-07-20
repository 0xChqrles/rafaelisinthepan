import { describe, expect, it } from 'vitest';
import type { BenchmarkEntry, Puzzle } from '@whippin/shared';
import { replayRun } from './benchmarkReplay';

const puzzle: Puzzle = {
  lang: 'fr',
  words: ['la', 'forêt', 'rencontre', "l'océan"],
  holes: [
    {
      pos: 1,
      secret: { word: 'forêt', slug: 'foret' },
      start: { word: 'bois', slug: 'bois' },
      start_rank: 50,
    },
    {
      pos: 3,
      secret: { word: 'océan', slug: 'ocean' },
      start: { word: 'lac', slug: 'lac' },
      start_rank: 40,
      prefix: "l'",
    },
  ],
  ranks: {
    foret: {
      bois: { word: 'bois', rank: 50 },
      partage: { word: 'partagé', rank: 10 },
      foret: { word: 'forêt', rank: 0 },
    },
    ocean: {
      lac: { word: 'lac', rank: 40 },
      partage: { word: 'partagé', rank: 5 },
      ocean: { word: 'océan', rank: 0 },
    },
  },
};

const repeatedPuzzle: Puzzle = {
  lang: 'fr',
  words: ['le', 'chat,', 'poursuit', 'le', 'chat', 'dans', 'le', 'jardin.'],
  holes: [
    {
      pos: 1,
      secret: { word: 'chat', slug: 'chat' },
      start: { word: 'animal', slug: 'animal' },
      start_rank: 50,
      suffix: ',',
    },
    {
      pos: 4,
      secret: { word: 'chat', slug: 'chat' },
      start: { word: 'bête', slug: 'bete' },
      start_rank: 50,
    },
    {
      pos: 7,
      secret: { word: 'jardin', slug: 'jardin' },
      start: { word: 'parc', slug: 'parc' },
      start_rank: 40,
      suffix: '.',
    },
  ],
  ranks: {
    chat: {
      animal: { word: 'animal', rank: 30 },
      bete: { word: 'bête', rank: 50 },
      chat: { word: 'chat', rank: 0 },
    },
    jardin: {
      parc: { word: 'parc', rank: 40 },
      jardin: { word: 'jardin', rank: 0 },
    },
  },
};

describe('replayRun — benchmark referee/client parity', () => {
  it('replays display forms, all-hole improvements, MISS tries, and the final score', () => {
    const entry: BenchmarkEntry = {
      model: 'claude-opus-4-8',
      label: 'CLAUDE OPUS',
      tag: 'OPUS',
      tries: 4,
      run: ['partagé', 'froid', 'forêt', 'océan'],
    };

    const replay = replayRun(puzzle, entry.run);

    expect(replay.tries).toBe(entry.tries);
    expect(replay.solved).toBe(true);
    expect(replay.holes.map((hole) => hole.rank)).toEqual([0, 0]);
    expect(replay.steps[0].slug).toBe('partage');
    expect(replay.steps[0].outcomes.map(({ rank, improved }) => [rank, improved])).toEqual([
      [10, true],
      [5, true],
    ]);
    expect(replay.steps[1].outcomes.map((outcome) => outcome.rank)).toEqual([null, null]);
    expect(replay.steps.at(-1)?.progress).toBeCloseTo(100, 9);
  });

  it('dedupes folded accent variants and keeps solved holes locked', () => {
    const replay = replayRun(puzzle, ['partagé', 'partage', 'forêt', 'partage', 'océan']);

    expect(replay.tries).toBe(3);
    expect(replay.steps.map((step) => step.word)).toEqual(['partagé', 'forêt', 'océan']);
    expect(replay.steps[2].outcomes).toHaveLength(1);
    expect(replay.steps[2].outcomes[0].holeIndex).toBe(1);
  });

  it('dedupes an inflected alias of an already-counted word, like guessKey and the referee (#104)', () => {
    // "partages" aliases the partagé entry in BOTH maps; replaying it after
    // "partagé" must not count a second try (parity with the Python referee).
    const aliased: Puzzle = structuredClone(puzzle);
    aliased.ranks.foret.partages = { word: 'partagé', rank: 10 };
    aliased.ranks.ocean.partages = { word: 'partagé', rank: 5 };

    const replay = replayRun(aliased, ['partagé', 'partages', 'forêt', 'océan']);

    expect(replay.tries).toBe(3);
    expect(replay.steps.map((step) => step.word)).toEqual(['partagé', 'forêt', 'océan']);
    expect(replay.solved).toBe(true);
  });

  it('reports a DNF run as unsolved while still counting cold valid guesses', () => {
    const entry: BenchmarkEntry = {
      model: 'gpt-5.6-sol',
      label: 'GPT-5.6',
      tag: 'GPT',
      tries: null,
      run: ['froid', 'autre'],
    };

    const replay = replayRun(puzzle, entry.run);

    expect(replay.tries).toBe(2);
    expect(replay.solved).toBe(false);
    expect(replay.steps.every((step) => step.outcomes.every((outcome) => outcome.rank === null))).toBe(
      true,
    );
  });

  it('broadcasts one shared-secret guess to every duplicate occurrence and counts it once', () => {
    const replay = replayRun(repeatedPuzzle, ['animal', 'chat', 'jardin']);

    expect(replay.tries).toBe(3);
    expect(replay.solved).toBe(true);
    expect(replay.holes.map((hole) => hole.pos)).toEqual([1, 4, 7]);
    expect(replay.holes.map((hole) => hole.rank)).toEqual([0, 0, 0]);
    expect(replay.steps[0].outcomes.map(({ holeIndex, rank }) => [holeIndex, rank])).toEqual([
      [0, 30],
      [1, 30],
      [2, null],
    ]);
    expect(replay.steps[1].outcomes.map(({ holeIndex, rank, solved }) => [holeIndex, rank, solved])).toEqual([
      [0, 0, true],
      [1, 0, true],
      [2, null, false],
    ]);
    expect(replay.steps[2].outcomes).toHaveLength(1);
    expect(replay.steps[2].outcomes[0].holeIndex).toBe(2);
  });
});
