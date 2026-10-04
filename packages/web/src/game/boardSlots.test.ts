import { describe, expect, it } from 'vitest';
import type { Board, BoardRow, PeriodBoard, PeriodRow, PlayingRow } from '@whippin/shared';
import { boardSlots, rankDigits, type BoardSlot } from './boardSlots';

// The list under the podium is the board's rows, each exactly once, in the board's order: the
// slot a line stands in times its arrival, so a row dropped, doubled or moved is a player
// missing from (or misplaced on) their own group's board.
const face = (publicId: string) => ({ publicId, name: publicId, avatar: null });
const ranked = (publicId: string, rank: number, score: number): BoardRow => ({ ...face(publicId), rank, score });
const playing = (publicId: string): PlayingRow => ({ ...face(publicId), tries: 12, progress: 40, over: false });
const pts = (publicId: string, rank: number, points: number): PeriodRow => ({
  ...face(publicId),
  rank,
  points,
  solvedDays: 2,
  total: 40,
});
const day = (over: Partial<Board>): Board => ({ rows: [], own: null, playing: [], waiting: [], ...over });

const read = (slots: BoardSlot[]) =>
  slots.map((slot) =>
    slot.kind === 'gap'
      ? 'gap'
      : slot.kind === 'ranked'
        ? `${slot.row.publicId}=${slot.value}`
        : slot.kind === 'playing'
          ? `~${slot.row.publicId}`
          : `.${slot.player.publicId}`,
  );

describe('boardSlots — a day', () => {
  const rows = [ranked('a', 1, 8), ranked('b', 2, 14), ranked('c', 3, 34), ranked('d', 4, 36), ranked('e', 5, 40)];

  it('lists the ranked rows past the podium\'s three, then the playing, then those not played yet', () => {
    const board = day({ rows, playing: [playing('p')], waiting: [face('w')] });
    expect(read(boardSlots(board, true))).toEqual(['d=36', 'e=40', '~p', '.w']);
  });

  it('lists every ranked row with no podium over the list', () => {
    expect(read(boardSlots(day({ rows: rows.slice(0, 2) }), false))).toEqual(['a=8', 'b=14']);
  });

  it('puts your own window below the cut under the rail of the rows left out', () => {
    const board = day({ rows, own: [ranked('x', 60, 88), ranked('me', 61, 90)] });
    expect(read(boardSlots(board, true))).toEqual(['d=36', 'e=40', 'gap', 'x=88', 'me=90']);
  });

  it('draws no caption between the sections: one slot a player, nothing else', () => {
    const board = day({ playing: [playing('p'), playing('q')], waiting: [face('w')] });
    expect(boardSlots(board, true)).toHaveLength(3);
  });
});

describe('boardSlots — a week or a month', () => {
  it('lists the ranked rows past the podium, each with its points alone', () => {
    const board: PeriodBoard = {
      from: '2026-09-28',
      to: '2026-10-03',
      rows: [pts('a', 1, 9), pts('b', 2, 6), pts('c', 3, 3), pts('d', 4, 1)],
    };
    expect(read(boardSlots(board, true))).toEqual(['d=1']);
    expect(read(boardSlots(board, false))).toEqual(['a=9', 'b=6', 'c=3', 'd=1']);
  });
});

describe('rankDigits — the rank column is as wide as the widest rank listed', () => {
  it('counts the ranked lines, your own window included', () => {
    const board = day({ rows: [ranked('a', 1, 8)], own: [ranked('me', 104, 90)], playing: [playing('p')] });
    expect(rankDigits(boardSlots(board, false))).toBe(3);
    expect(rankDigits(boardSlots(day({ waiting: [face('w')] }), false))).toBe(0);
  });
});
