// CONTRACT (#156 — the Word mode board model): the zone renders as censored stations
// until claimed, a claim reveals its group's canonical form, the run ending reveals the
// WHOLE field (the post-mortem), near strikes ride the trunk with their word shown, and
// off-map strikes land on the misses shelf. Lanes come from the data's distinct roads.

import { describe, it, expect } from 'vitest';
import type { WordRanks } from '@whippin/shared';
import { buildWordBoard, hasWordBoard } from './wordBoard';

const RANKS: WordRanks = {
  tropiques: { word: 'tropiques', rank: 0 },
  tropicales: { word: 'tropicales', rank: 1, dq: 255, road: 0 },
  tropical: { word: 'tropicales', rank: 1, dq: 255, road: 0 },
  cocotier: { word: 'cocotier', rank: 2, dq: 236, road: 1 },
  lagon: { word: 'lagon', rank: 3, dq: 200, road: 1 },
  sable: { word: 'sable', rank: 151, dq: 39 },
  neige: { word: 'neige', rank: 353, dq: 12 },
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
    expect(board.outside).toEqual([{ rank: 151, dq: 39, word: 'sable' }]);
    expect(board.misses).toEqual(['guitare']);
  });

  it('the run ending reveals the whole field (the post-mortem)', () => {
    const board = buildWordBoard({
      ranks: RANKS,
      word: WORD,
      tried: ['sable', 'neige', 'guitare'],
    })!;
    expect(board.ended).toBe(true);
    expect(board.stations.map((s) => s.word)).toEqual(['tropicales', 'cocotier', 'lagon']);
    // Revealed-by-ending is not claiming: nothing counts as claimed.
    expect(board.stations.every((s) => !s.claimed)).toBe(true);
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
