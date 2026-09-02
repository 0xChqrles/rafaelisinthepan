// CONTRACT (#156 — the Word mode board model; since #163 it is the END SCREEN's; since
// 2026-09-01 a plain GRID of the zone's words): the zone renders as censored stations until
// claimed, a claim reveals its group's canonical form, `reveal` names the WHOLE field (the
// post-mortem). RARITY IS THE STATION WORD'S COLOUR: every zone station carries its grade,
// and `grades` lists only what the field actually holds. The model states no `ended`: when
// a run is over is the DEADLINE's to say (#163), and the log cannot see a wall clock — and
// no geometry: the grid draws no distance.

import { describe, it, expect } from 'vitest';
import type { WordRanks } from '@whippin/shared';
import { buildWordBoard } from './wordBoard';
import { CLAIM_ZONE, RARITY_LADDER, RARITY_NAMES } from './wordGame';

// The two ranked groups OUTSIDE the claimable zone, positioned AGAINST the zone rather than
// typed as literals: the zone is a tuning knob (150 -> 250 on 2026-08-07) and a fixed number
// silently falls inside it on the next widening, turning both near misses into claims and
// leaving the trunk untested.
const NEAR_RANK = CLAIM_ZONE + 1;
const FAR_RANK = CLAIM_ZONE + 100;

// A corpus to grade against, and a `freq` landing inside grade `index` — derived from the
// ladder rather than typed, so retuning the cuts cannot silently re-grade this fixture.
const CORPUS = 100_000;
const inGrade = (index: number): number =>
  Number.isFinite(RARITY_LADDER[index].within)
    ? Math.floor(RARITY_LADDER[index].within * CORPUS)
    : CORPUS * 10;

// Three zone groups over TWO grades (0 and 2) with one in between skipped, so "only the
// grades present are listed" is actually exercised, plus two ranked groups past the zone.
const RANKS: WordRanks = {
  tropiques: { word: 'tropiques', rank: 0 },
  tropicales: { word: 'tropicales', rank: 1, dq: 255, freq: inGrade(0) },
  tropical: { word: 'tropicales', rank: 1, dq: 255, freq: inGrade(0) },
  cocotier: { word: 'cocotier', rank: 2, dq: 236, freq: inGrade(2) },
  lagon: { word: 'lagon', rank: 3, dq: 200, freq: inGrade(0) },
  sable: { word: 'sable', rank: NEAR_RANK, dq: 39 },
  sables: { word: 'sable', rank: NEAR_RANK, dq: 39 },
  neige: { word: 'neige', rank: FAR_RANK, dq: 12 },
};

const WORD = 'tropiques';
const build = (tried: string[] = [], reveal = false) =>
  buildWordBoard({ ranks: RANKS, word: WORD, tried, corpusSize: CORPUS, reveal });

describe('buildWordBoard', () => {
  it('the word is public from the first frame; the zone starts fully censored', () => {
    const board = build();
    expect(board.word).toBe(WORD);
    expect(board.stations.map((s) => s.word)).toEqual([null, null, null]);
  });

  it('a claim reveals its group (canonical form), through any alias', () => {
    const board = build(['tropical']);
    const rank1 = board.stations.find((s) => s.rank === 1)!;
    expect(rank1.word).toBe('tropicales');
    expect(rank1.claimed).toBe(true);
    // The rest of the field stays censored.
    expect(board.stations.filter((s) => s.word === null)).toHaveLength(2);
  });

  it('`reveal` names the whole field — the post-mortem the dead clock earns', () => {
    const board = build(['neige'], true);
    expect(board.stations.map((s) => s.word)).toEqual(['tropicales', 'cocotier', 'lagon']);
    // Revealed is not claimed: naming what was always there is not finding it.
    expect(board.stations.every((s) => !s.claimed)).toBe(true);
  });

  it('the field stays censored until the reveal beat, claims excepted', () => {
    // The screen holds the reveal until the clock's last moment has played out, so the
    // board must be drawable un-revealed at any point of a run. What the player EARNED
    // never waits for that beat.
    const held = build(['tropical', 'neige']);
    expect(held.stations.find((s) => s.rank === 1)!.word).toBe('tropicales');
    expect(held.stations.filter((s) => s.word === null)).toHaveLength(2);
  });

  it('a ranked guess OUTSIDE the zone and an off-map guess claim nothing', () => {
    const board = build(['sable', 'guitare']);
    expect(board.stations.every((s) => !s.claimed && s.word === null)).toBe(true);
  });
});

describe('the grades are RARITY, graded per station', () => {
  it('a station rides its own grade, read off `freq` against the corpus', () => {
    const board = build();
    expect(board.stations.map((s) => [s.rank, s.rarity])).toEqual([
      [1, RARITY_NAMES[0]],
      [2, RARITY_NAMES[2]],
      [3, RARITY_NAMES[0]],
    ]);
  });

  it('only the grades the field HOLDS are listed, in ladder order', () => {
    // A grade the day's zone does not contain is not listed: a permanently empty one
    // advertises a route nobody can walk (an English board often has no ARCANE group at
    // all). Commonest first, so two days' boards are read the same way.
    expect(build().grades).toEqual([RARITY_NAMES[0], RARITY_NAMES[2]]);
  });

  it('grades the whole field even with no `freq` at all — all COMMON, never none', () => {
    // `freq` is optional by contract, and the floor is COMMON everywhere else in the
    // economy. So a map without it still draws: every station graded COMMON.
    const noFreq: WordRanks = {
      mot: { word: 'mot', rank: 0 },
      proche: { word: 'proche', rank: 1, dq: 255 },
      loin: { word: 'loin', rank: 2, dq: 100 },
    };
    const board = buildWordBoard({ ranks: noFreq, word: 'mot', tried: [], corpusSize: CORPUS });
    expect(board.grades).toEqual([RARITY_NAMES[0]]);
    expect(board.stations.every((s) => s.rarity === RARITY_NAMES[0])).toBe(true);
  });

  it('grades against the CORPUS, so the same field grades differently in two languages', () => {
    // The same `freq` is a different rarity in a 75k vocabulary and a 128k one — the whole
    // reason the economy takes a corpus size. The colours must follow the same rule the clock
    // does, or a station wears one grade and pays for another.
    const small = buildWordBoard({ ranks: RANKS, word: WORD, tried: [], corpusSize: CORPUS / 8 });
    expect(small.grades).not.toEqual(build().grades);
    expect(small.stations.find((s) => s.rank === 1)!.rarity).not.toBe(RARITY_NAMES[0]);
  });
});
