import { describe, expect, it } from 'vitest';
import { benchmarkRanking, lineupModel, lineupEvents } from './benchmark';
import type { BenchmarkResults } from '@whippin/shared';

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

// The mid-game standings lineup (#81) shares the ranking contract: ascending tries,
// stable ties in curator order, player inserted last, DNF far right.
const ENTRIES: BenchmarkResults = [
  { model: 'kimi-k3', label: 'KIMI K3', tag: 'KIMI', tries: 8, run: ['a'] },
  { model: 'claude-fable-5', label: 'CLAUDE FABLE', tag: 'FABLE', tries: 12, run: ['a'] },
  { model: 'gpt-5.6-sol', label: 'GPT-5.6', tag: 'GPT', tries: null, run: ['a'] },
];

describe('lineupModel', () => {
  it('starts the player far left at 0 with DNF models far right', () => {
    const { entrants, playerIndex } = lineupModel(ENTRIES, 0, 'YOU');
    expect(entrants.map((e) => e.key)).toEqual([
      'player',
      'kimi-k3',
      'claude-fable-5',
      'gpt-5.6-sol',
    ]);
    expect(playerIndex).toBe(0);
    expect(entrants[0]).toMatchObject({ tag: 'YOU', tries: 0, player: true });
  });

  it('keeps the opponents wearing their fixed puzzle-order sprite across reorders', () => {
    const { entrants } = lineupModel(ENTRIES, 10, 'YOU');
    expect(entrants.map((e) => [e.key, e.sprite])).toEqual([
      ['kimi-k3', 0],
      ['player', -1],
      ['claude-fable-5', 1],
      ['gpt-5.6-sol', 2],
    ]);
  });

  it('puts the player to the RIGHT of an opponent the moment the count reaches its score', () => {
    // At 7 the player still leads; at 8 (== KIMI's score) the tie goes to the finished model.
    expect(lineupModel(ENTRIES, 7, 'YOU').playerIndex).toBe(0);
    const at8 = lineupModel(ENTRIES, 8, 'YOU');
    expect(at8.entrants.map((e) => e.key)).toEqual([
      'kimi-k3',
      'player',
      'claude-fable-5',
      'gpt-5.6-sol',
    ]);
    expect(at8.playerIndex).toBe(1);
  });

  it('keeps tied models in curator order with the player after BOTH', () => {
    const tied: BenchmarkResults = [
      { ...ENTRIES[0], tries: 5 },
      { ...ENTRIES[1], tries: 5 },
      ENTRIES[2],
    ];
    expect(lineupModel(tied, 5, 'YOU').entrants.map((e) => e.key)).toEqual([
      'kimi-k3',
      'claude-fable-5',
      'player',
      'gpt-5.6-sol',
    ]);
  });

  it('never places the player after a DNF model', () => {
    expect(lineupModel(ENTRIES, 999, 'YOU').entrants.map((e) => e.key)).toEqual([
      'kimi-k3',
      'claude-fable-5',
      'player',
      'gpt-5.6-sol',
    ]);
  });
});

describe('lineupEvents', () => {
  const at = (tries: number) => lineupModel(ENTRIES, tries, 'YOU');

  it('reports nothing when the standings did not change', () => {
    expect(lineupEvents(at(3), at(4))).toEqual({ passedBy: [], lostLead: false });
  });

  it('flags the crown transfer when the best model catches the player', () => {
    const events = lineupEvents(at(7), at(8));
    expect(events.lostLead).toBe(true);
    expect(events.passedBy.map((e) => e.key)).toEqual(['kimi-k3']);
  });

  it('reports a later pass without a second crown transfer', () => {
    const events = lineupEvents(at(11), at(12));
    expect(events.lostLead).toBe(false);
    expect(events.passedBy.map((e) => e.key)).toEqual(['claude-fable-5']);
  });

  it('reports every opponent passed at once when scores are equal', () => {
    const tied: BenchmarkResults = [
      { ...ENTRIES[0], tries: 5 },
      { ...ENTRIES[1], tries: 5 },
      ENTRIES[2],
    ];
    const events = lineupEvents(
      lineupModel(tied, 4, 'YOU'),
      lineupModel(tied, 5, 'YOU'),
    );
    expect(events.lostLead).toBe(true);
    expect(events.passedBy.map((e) => e.key)).toEqual(['kimi-k3', 'claude-fable-5']);
  });
});
