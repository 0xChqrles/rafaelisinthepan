import { describe, expect, it } from 'vitest';
import { benchmarkRanking } from './benchmark';

describe('benchmarkRanking', () => {
  it('inserts the player, sorts ascending, and leaves DNF models last', () => {
    const ranking = benchmarkRanking(
      [
        {
          model: 'claude-opus-4-8',
          label: 'CLAUDE OPUS',
          tag: 'OPUS',
          tries: 32,
          run: ['forest'],
        },
        {
          model: 'claude-sonnet-5',
          label: 'CLAUDE SONNET',
          tag: 'SONNET',
          tries: 51,
          run: ['forest'],
        },
        {
          model: 'gpt-5.6-sol',
          label: 'GPT-5.6',
          tag: 'GPT',
          tries: null,
          run: ['forest'],
        },
      ],
      45,
      'YOU',
    );

    expect(ranking).toEqual([
      { label: 'CLAUDE OPUS', tries: 32, player: false },
      { label: 'YOU', tries: 45, player: true },
      { label: 'CLAUDE SONNET', tries: 51, player: false },
      { label: 'GPT-5.6', tries: null, player: false },
    ]);
  });
});
