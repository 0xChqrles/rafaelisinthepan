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
});
