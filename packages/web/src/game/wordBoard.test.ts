// CONTRACT (#156 — the Word mode board model; since #163 it is the END SCREEN's drawing):
// the zone renders as censored stations until claimed, a claim reveals its group's
// canonical form, `reveal` names the WHOLE field (the post-mortem), near misses ride the
// trunk showing the form the player TYPED, and off-map guesses land on the misses shelf.
// Lanes come from the data's distinct roads. The model states no `ended`: when a run is
// over is the DEADLINE's to say (#163), and the log cannot see a wall clock.

import { describe, it, expect } from 'vitest';
import type { WordRanks } from '@whippin/shared';
import { buildWordBoard, hasWordBoard } from './wordBoard';
import { CLAIM_ZONE } from './wordGame';

// The two ranked groups OUTSIDE the claimable zone, positioned AGAINST the zone rather than
// typed as literals: the zone is a tuning knob (150 -> 250 on 2026-08-07) and a fixed number
// silently falls inside it on the next widening, turning both near misses into claims and
// leaving the trunk untested.
const NEAR_RANK = CLAIM_ZONE + 1;
const FAR_RANK = CLAIM_ZONE + 100;

const RANKS: WordRanks = {
  tropiques: { word: 'tropiques', rank: 0 },
  tropicales: { word: 'tropicales', rank: 1, dq: 255, road: 0 },
  tropical: { word: 'tropicales', rank: 1, dq: 255, road: 0 },
  cocotier: { word: 'cocotier', rank: 2, dq: 236, road: 1 },
  lagon: { word: 'lagon', rank: 3, dq: 200, road: 1 },
  sable: { word: 'sable', rank: NEAR_RANK, dq: 39 },
  sables: { word: 'sable', rank: NEAR_RANK, dq: 39 },
  neige: { word: 'neige', rank: FAR_RANK, dq: 12 },
};

const WORD = 'tropiques';

describe('buildWordBoard', () => {
  it('the word is public from the first frame; the zone starts fully censored', () => {
    const board = buildWordBoard({ ranks: RANKS, word: WORD, tried: [] })!;
    expect(board.word).toBe(WORD);
    expect(board.stations.map((s) => s.word)).toEqual([null, null, null]);
    expect(board.lanes).toBe(2);
  });

  it('a claim reveals its group (canonical form), through any alias', () => {
    const board = buildWordBoard({ ranks: RANKS, word: WORD, tried: ['tropical'] })!;
    const rank1 = board.stations.find((s) => s.rank === 1)!;
    expect(rank1.word).toBe('tropicales');
    expect(rank1.claimed).toBe(true);
    // The rest of the field stays censored.
    expect(board.stations.filter((s) => s.word === null)).toHaveLength(2);
  });

  it('a near miss rides the trunk with its word and rank shown; a miss shelves', () => {
    const board = buildWordBoard({ ranks: RANKS, word: WORD, tried: ['sable', 'guitare'] })!;
    expect(board.outside).toEqual([{ rank: NEAR_RANK, dq: 39, word: 'sable' }]);
    expect(board.misses).toEqual(['guitare']);
  });

  it('a near miss shows the form the player TYPED, not its group canonical one', () => {
    // Off the roads nothing was drawn before the guess landed, so the stop IS the guess:
    // answering `sables` with `sable` puts a word on the board that was never played. The
    // claim above is the opposite case — that station was already there as `???`.
    const board = buildWordBoard({ ranks: RANKS, word: WORD, tried: ['sables'] })!;
    expect(board.outside).toEqual([{ rank: NEAR_RANK, dq: 39, word: 'sables' }]);
  });

  it('`reveal` names the whole field — the post-mortem the dead clock earns', () => {
    const board = buildWordBoard({ ranks: RANKS, word: WORD, tried: ['neige'], reveal: true })!;
    expect(board.stations.map((s) => s.word)).toEqual(['tropicales', 'cocotier', 'lagon']);
    // Revealed is not claimed: naming what was always there is not finding it.
    expect(board.stations.every((s) => !s.claimed)).toBe(true);
  });

  it('the field stays censored until the reveal beat, claims excepted', () => {
    // The screen holds the reveal until the clock's last moment has played out, so the
    // board must be drawable un-revealed at any point of a run. What the player EARNED
    // never waits for that beat.
    const held = buildWordBoard({ ranks: RANKS, word: WORD, tried: ['tropical', 'neige'] })!;
    expect(held.stations.find((s) => s.rank === 1)!.word).toBe('tropicales');
    expect(held.stations.filter((s) => s.word === null)).toHaveLength(2);
  });

  it('states the map FARTHEST rank, so the rank gutter can be reserved up front', () => {
    // The drawing sizes its gutter from this rather than from the widest exponent currently
    // drawn — otherwise the first far strike widens the track and shoves the whole line
    // sideways. So it must be the MAP's outer edge, and must not move when a guess lands.
    const empty = buildWordBoard({ ranks: RANKS, word: WORD, tried: [] })!;
    expect(empty.maxRank).toBe(FAR_RANK); // `neige`, well outside the zone
    for (const tried of [['sable'], ['sables', 'guitare'], ['tropicales', 'neige']]) {
      expect(buildWordBoard({ ranks: RANKS, word: WORD, tried })!.maxRank).toBe(FAR_RANK);
    }
  });

  it('an artifact with no drawable geometry has no board', () => {
    const bare: WordRanks = {
      mot: { word: 'mot', rank: 0 },
      proche: { word: 'proche', rank: 1 }, // no dq — pre-#115-shaped data
    };
    expect(hasWordBoard(bare)).toBe(false);
    expect(buildWordBoard({ ranks: bare, word: 'mot', tried: [] })).toBeNull();
  });
});
