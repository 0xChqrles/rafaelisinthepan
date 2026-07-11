import { describe, expect, it } from 'vitest';
import { benchmarkRanking } from './benchmark';

describe('benchmarkRanking', () => {
  it('inserts the player, sorts ascending, and leaves DNF models last', () => {
    const ranking = benchmarkRanking(
      [
        { model: 'claude-opus-4-8', label: 'OPUS', tries: 32 },
        { model: 'claude-sonnet-5', label: 'SONNET', tries: 51 },
        { model: 'gpt-5.6-sol', label: 'GPT', tries: null },
      ],
      45,
      'YOU',
    );

    expect(ranking).toEqual([
      { label: 'OPUS', tries: 32, player: false },
      { label: 'YOU', tries: 45, player: true },
      { label: 'SONNET', tries: 51, player: false },
      { label: 'GPT', tries: null, player: false },
    ]);
  });

  it('keeps the player in the race when the benchmark array is empty', () => {
    expect(benchmarkRanking([], 7, 'TOI')).toEqual([{ label: 'TOI', tries: 7, player: true }]);
  });
});
