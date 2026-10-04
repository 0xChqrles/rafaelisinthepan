import type { BoardPlayer, PlayingRow } from '@whippin/shared';
import { isPeriodBoard, type AnyBoard } from './boardView';
import { dayPodium, periodPodium } from './podium';

// THE BOARD SCREEN'S LIST, slot by slot (pure, tested): what the column lists under the podium,
// in order, one item a slot — a line comes in on its slot's beat, so the order is decided here,
// once, and the screen only draws it. Past the podium's three (or all of them, with no podium):
//   A DAY: the ranked rows; on GLOBAL below the cut, the rail of the rows left out and the
//     caller's own window under it; then the members still playing (or done with nothing
//     recorded); then those who have not played yet. NO CAPTION between them — the lines say it:
//     no rank and the heat's % is a round being played, `∞` one that ended, a muted name with
//     nothing where a number would be a member who has not played.
//   A WEEK or a MONTH: the ranked rows, each with its POINTS alone — the period rule's other
//     numbers (solved days, then tries) order the rows and are not shown.
// (An empty board is the podium's ghost: no list.)
export type BoardSlot =
  | { kind: 'ranked'; row: BoardPlayer & { rank: number }; value: number }
  | { kind: 'gap' }
  | { kind: 'playing'; row: PlayingRow }
  | { kind: 'waiting'; player: BoardPlayer };

export function boardSlots(board: AnyBoard, podium: boolean): BoardSlot[] {
  if (isPeriodBoard(board)) {
    const ranked = podium ? periodPodium(board.rows).lines : board.rows;
    return ranked.map((row) => ({ kind: 'ranked', row, value: row.points }));
  }
  const ranked = podium ? dayPodium(board.rows).lines : board.rows;
  const own = board.own ?? [];
  return [
    ...ranked.map((row): BoardSlot => ({ kind: 'ranked', row, value: row.score })),
    ...(own.length > 0
      ? [{ kind: 'gap' } as const, ...own.map((row): BoardSlot => ({ kind: 'ranked', row, value: row.score }))]
      : []),
    ...board.playing.map((row): BoardSlot => ({ kind: 'playing', row })),
    ...board.waiting.map((player): BoardSlot => ({ kind: 'waiting', player })),
  ];
}

// The widest rank the list prints, in digits (the rank column is as wide as it).
export function rankDigits(slots: readonly BoardSlot[]): number {
  return Math.max(0, ...slots.map((slot) => (slot.kind === 'ranked' ? String(slot.row.rank).length : 0)));
}
