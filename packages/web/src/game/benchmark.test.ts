import { describe, expect, it } from 'vitest';
import {
  lineupModel,
  lineupEvents,
  displayEntries,
  hasDisplayEntries,
} from './benchmark';
import type { BenchmarkResults } from '@whippin/shared';

// The mid-game standings lineup (#81): ascending tries, model ties in canonical display
// order, DNF far right. A tie with the player keeps the PLAYER ahead — an opponent
// passes only when the live count strictly EXCEEDS its score (decided 2026-07-24; the
// solved-screen ranking shares this rule, #110). Sprites are the canonical DISPLAY_MODEL_IDS
// index (FABLE=0, KIMI=1, GPT=2), stable across reorders AND regardless of which of the
// three are present. Recorded in a non-canonical order to prove the filter re-orders by
// the canonical trio.
const ENTRIES: BenchmarkResults = [
  { model: 'k3', label: 'KIMI K3', tag: 'KIMI', tries: 8, run: ['a'] },
  { model: 'claude-fable-5', label: 'CLAUDE FABLE', tag: 'FABLE', tries: 12, run: ['a'] },
  { model: 'gpt-5.6-sol', label: 'GPT-5.6', tag: 'GPT', tries: null, run: ['a'] },
];

describe('displayEntries', () => {
  it('keeps only the display trio, in canonical order, ignoring lab-only models', () => {
    const withLabOnly: BenchmarkResults = [
      { model: 'claude-opus-4-8', label: 'CLAUDE OPUS', tag: 'OPUS', tries: 3, run: ['a'] },
      ...ENTRIES,
      { model: 'gpt-5.6-terra', label: 'GPT-5.6 TERRA', tag: 'TERRA', tries: 4, run: ['a'] },
    ];
    expect(displayEntries(withLabOnly).map((d) => [d.entry.model, d.sprite])).toEqual([
      ['claude-fable-5', 0],
      ['k3', 1],
      ['gpt-5.6-sol', 2],
    ]);
  });

  it('reports a present subset and keeps each model on its canonical sprite', () => {
    const partial: BenchmarkResults = [
      { model: 'gpt-5.6-sol', label: 'GPT-5.6', tag: 'GPT', tries: 9, run: ['a'] },
    ];
    expect(displayEntries(partial).map((d) => [d.entry.model, d.sprite])).toEqual([
      ['gpt-5.6-sol', 2],
    ]);
    expect(hasDisplayEntries(partial)).toBe(true);
  });

  it('treats a benchmark of only lab-only models as no lineup', () => {
    const labOnly: BenchmarkResults = [
      { model: 'claude-opus-4-8', label: 'CLAUDE OPUS', tag: 'OPUS', tries: 3, run: ['a'] },
    ];
    expect(displayEntries(labOnly)).toEqual([]);
    expect(hasDisplayEntries(labOnly)).toBe(false);
    expect(hasDisplayEntries(undefined)).toBe(false);
  });
});

describe('lineupModel', () => {
  it('starts the player far left at 0 with DNF models far right', () => {
    const { entrants, playerIndex } = lineupModel(ENTRIES, 0, 'YOU');
    // Opponent scores: k3=8 < fable=12 < gpt(DNF); the player at 0 leads them all.
    expect(entrants.map((e) => e.key)).toEqual([
      'player',
      'k3',
      'claude-fable-5',
      'gpt-5.6-sol',
    ]);
    expect(playerIndex).toBe(0);
    expect(entrants[0]).toMatchObject({ tag: 'YOU', tries: 0, player: true });
  });

  it('keeps the opponents wearing their canonical display sprite across reorders', () => {
    // At 10 the player sits between k3 (8) and fable (12); sprites stay canonical
    // (fable=0, k3=1, gpt=2) even though k3 outranks fable on tries.
    const { entrants } = lineupModel(ENTRIES, 10, 'YOU');
    expect(entrants.map((e) => [e.key, e.sprite])).toEqual([
      ['k3', 1],
      ['player', -1],
      ['claude-fable-5', 0],
      ['gpt-5.6-sol', 2],
    ]);
  });

  it('adapts to a present subset (player + one opponent)', () => {
    const partial: BenchmarkResults = [
      { model: 'k3', label: 'KIMI K3', tag: 'KIMI', tries: 8, run: ['a'] },
    ];
    const { entrants, playerIndex } = lineupModel(partial, 3, 'YOU');
    expect(entrants.map((e) => e.key)).toEqual(['player', 'k3']);
    expect(playerIndex).toBe(0);
  });

  it('puts the player to the RIGHT of an opponent only when the count EXCEEDS its score', () => {
    // At 8 (== KIMI's score) the tie keeps the player ahead; at 9 KIMI moves in front.
    expect(lineupModel(ENTRIES, 8, 'YOU').playerIndex).toBe(0);
    const at9 = lineupModel(ENTRIES, 9, 'YOU');
    expect(at9.entrants.map((e) => e.key)).toEqual([
      'k3',
      'player',
      'claude-fable-5',
      'gpt-5.6-sol',
    ]);
    expect(at9.playerIndex).toBe(1);
  });

  it('keeps the player AHEAD of models it ties, themselves in canonical order', () => {
    const tied: BenchmarkResults = [
      { ...ENTRIES[0], tries: 5 },
      { ...ENTRIES[1], tries: 5 },
      ENTRIES[2],
    ];
    expect(lineupModel(tied, 5, 'YOU').entrants.map((e) => e.key)).toEqual([
      'player',
      'claude-fable-5',
      'k3',
      'gpt-5.6-sol',
    ]);
  });

  it('never places the player after a DNF model', () => {
    expect(lineupModel(ENTRIES, 999, 'YOU').entrants.map((e) => e.key)).toEqual([
      'k3',
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

  it('reports nothing when the count only CATCHES the best model', () => {
    expect(lineupEvents(at(7), at(8))).toEqual({ passedBy: [], lostLead: false });
  });

  it('flags the lead loss when the best model overtakes the player', () => {
    const events = lineupEvents(at(8), at(9));
    expect(events.lostLead).toBe(true);
    expect(events.passedBy.map((e) => e.key)).toEqual(['k3']);
  });

  it('reports a later pass without a second lead loss', () => {
    const events = lineupEvents(at(12), at(13));
    expect(events.lostLead).toBe(false);
    expect(events.passedBy.map((e) => e.key)).toEqual(['claude-fable-5']);
  });

  it('reports every opponent passed at once when their scores are equal', () => {
    const tied: BenchmarkResults = [
      { ...ENTRIES[0], tries: 5 },
      { ...ENTRIES[1], tries: 5 },
      ENTRIES[2],
    ];
    const events = lineupEvents(
      lineupModel(tied, 5, 'YOU'),
      lineupModel(tied, 6, 'YOU'),
    );
    expect(events.lostLead).toBe(true);
    expect(events.passedBy.map((e) => e.key)).toEqual(['claude-fable-5', 'k3']);
  });
});
