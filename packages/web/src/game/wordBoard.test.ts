// CONTRACT (#156 — the Word mode board model): the zone renders as censored stations
// until claimed, a claim reveals its group's canonical form, the run ending reveals the
// WHOLE field (the post-mortem), near strikes ride the trunk showing the form the player
// TYPED, and off-map strikes land on the misses shelf. Lanes come from the data's distinct
// roads.

import { describe, it, expect } from 'vitest';
import type { WordRanks } from '@whippin/shared';
import { buildWordBoard, hasWordBoard } from './wordBoard';
import { CLAIM_ZONE, STRIKES_TO_END } from './wordGame';

// `n` DISTINCT off-map words — distinct guesses by the slug fallback, so each one strikes.
const offMap = (n: number): string[] => Array.from({ length: n }, (_, i) => `motfaux${i}`);

// The two ranked groups OUTSIDE the claimable zone, positioned AGAINST the zone rather than
// typed as literals: the zone is a tuning knob (150 -> 250 on 2026-08-07) and a fixed number
// silently falls inside it on the next widening, turning both near strikes into claims and
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
    expect(board.ended).toBe(false);
  });

  it('a claim reveals its group (canonical form), through any alias', () => {
    const board = buildWordBoard({ ranks: RANKS, word: WORD, tried: ['tropical'] })!;
    const rank1 = board.stations.find((s) => s.rank === 1)!;
    expect(rank1.word).toBe('tropicales');
    expect(rank1.claimed).toBe(true);
    // The rest of the field stays censored.
    expect(board.stations.filter((s) => s.word === null)).toHaveLength(2);
  });

  it('a near strike rides the trunk with its word and rank shown; a miss shelves', () => {
    const board = buildWordBoard({ ranks: RANKS, word: WORD, tried: ['sable', 'guitare'] })!;
    expect(board.outside).toEqual([{ rank: NEAR_RANK, dq: 39, word: 'sable' }]);
    expect(board.misses).toEqual(['guitare']);
  });

  it('a near strike shows the form the player TYPED, not its group canonical one', () => {
    // Off the roads nothing was drawn before the guess landed, so the stop IS the guess:
    // answering `sables` with `sable` puts a word on the board that was never played. The
    // claim above is the opposite case — that station was already there as `???`.
    const board = buildWordBoard({ ranks: RANKS, word: WORD, tried: ['sables'] })!;
    expect(board.outside).toEqual([{ rank: NEAR_RANK, dq: 39, word: 'sables' }]);
  });

  it('the run ending reveals the whole field (the post-mortem)', () => {
    // Enough DISTINCT incorrect guesses to strike out, derived from the rule's own constant:
    // the two ranked near misses this map carries, then off-map words.
    const strikeOut = ['sable', 'neige', ...offMap(Math.max(0, STRIKES_TO_END - 2))].slice(
      0,
      STRIKES_TO_END,
    );
    const board = buildWordBoard({ ranks: RANKS, word: WORD, tried: strikeOut })!;
    expect(board.ended).toBe(true);
    expect(board.stations.map((s) => s.word)).toEqual(['tropicales', 'cocotier', 'lagon']);
    // Revealed-by-ending is not claiming: nothing counts as claimed.
    expect(board.stations.every((s) => !s.claimed)).toBe(true);
  });

  it('`reveal` paces the post-mortem without touching the run facts', () => {
    // The screen holds the reveal until the killing strike has played out. The board stays
    // censored while `reveal` is false — claims excepted, they were earned — but `ended`
    // is the replay's fact and never waits for presentation.
    const strikeOut = ['sable', 'neige', ...offMap(Math.max(0, STRIKES_TO_END - 2))].slice(
      0,
      STRIKES_TO_END,
    );
    const held = buildWordBoard({ ranks: RANKS, word: WORD, tried: strikeOut, reveal: false })!;
    expect(held.ended).toBe(true);
    expect(held.stations.map((s) => s.word)).toEqual([null, null, null]);
    const claimedHeld = buildWordBoard({
      ranks: RANKS,
      word: WORD,
      tried: ['tropical', ...strikeOut],
      reveal: false,
    })!;
    expect(claimedHeld.stations.find((s) => s.rank === 1)!.word).toBe('tropicales');
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
