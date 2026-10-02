// THE RESULT'S BOARDS (pure): how the player's finished day compares, under SHARE — each of
// their groups in turn off the live read (`state/liveBoard.ts`), then the WORLD off the global
// board. A few rows each, in a box of one fixed size, so the block can hold its footprint before
// any read lands and a swipe between groups moves nothing under it.
//
// ONE group's lines are the boards' own reading, never a second spelling: the members who
// RECORDED a score today ranked by the shared `rankBoard` (a rank belongs to one group, so the
// live read's merged rows are cut by the group's member list first), then the members still
// playing by the shared `orderPlaying` (an ended-unsolved round after every live one). Shown: the
// whole day when it fits the box; otherwise the podium (the first three ranked rows), the
// player's own row with the one just ahead and the one just behind, a few of the playing rows,
// and how many rows that left out (`more`).
//
// THE PLAYER'S OWN ROW comes from their own result, never from a guess: ranked when the server
// recorded their score; otherwise an unranked playing row — `∞` when the round ended unsolved, a
// finished 100% when it was solved with no recorded score (late, or refused by the IP floor) —
// which never claims a rank. The WORLD invents nothing: no recorded score, no own row.

import {
  orderPlaying,
  rankBoard,
  type Board,
  type BoardPlayer,
  type BoardRow,
  type LiveBoard,
  type LiveGroup,
  type PlayingRow,
} from '@whippin/shared';

export type ResultLine =
  | { kind: 'ranked'; row: BoardRow; me: boolean }
  // Rows of the ranking left out between two shown ones.
  | { kind: 'gap' }
  | { kind: 'playing'; row: PlayingRow; me: boolean };

export interface ResultBoard {
  lines: ResultLine[];
  // Rows with a day of their own that the lines leave out.
  more: number;
}

export interface ResultTab {
  // A group's id, or `WORLD_TAB`.
  key: string;
  // The group, or null for the WORLD.
  group: LiveGroup | null;
  board: ResultBoard;
}

// The player, as their own result says: their face, their tries, how far they got (the
// trajectory's last %), and whether the round ENDED UNSOLVED (given up, or capped).
export interface ResultMe extends BoardPlayer {
  tries: number;
  progress: number;
  ended: boolean;
}

export const WORLD_TAB = 'world';
// The box's rows: a podium and a window of three, or a podium, the player and two playing.
export const RESULT_LINES_MAX = 6;
// The playing rows a group shows besides the player's own.
export const RESULT_PLAYING_MAX = 2;
const PODIUM = 3;

// Rows ranked best-first and CONTIGUOUS around the player: all of them when `all`, else the
// podium and the player's ±1 window, with a gap where the two do not touch.
function rankedLines(
  ranked: readonly BoardRow[],
  meId: string,
  all: boolean,
): { lines: ResultLine[]; shown: number } {
  const at = ranked.findIndex((row) => row.publicId === meId);
  const keep = new Set<number>();
  for (let i = 0; i < (all ? ranked.length : Math.min(PODIUM, ranked.length)); i += 1) keep.add(i);
  if (at >= 0) {
    for (const i of [at - 1, at, at + 1]) if (i >= 0 && i < ranked.length) keep.add(i);
  }
  const lines: ResultLine[] = [];
  let last = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (last >= 0 && i > last + 1) lines.push({ kind: 'gap' });
    lines.push({ kind: 'ranked', row: ranked[i], me: i === at });
    last = i;
  }
  return { lines, shown: keep.size };
}

// ONE group's day. Null when nobody but the player has a row in it today: there is nobody to
// compare with.
export function groupResult(live: LiveBoard, group: LiveGroup, me: ResultMe): ResultBoard | null {
  const members = new Set(group.members);
  const scores = live.rows.filter((row) => members.has(row.publicId));
  const players = live.playing.filter((row) => members.has(row.publicId) && row.publicId !== me.publicId);
  const faces = new Map(scores.map((row) => [row.publicId, row]));
  const ranked: BoardRow[] = rankBoard(scores).map((row) => {
    const { name, avatar } = faces.get(row.publicId)!;
    return { ...row, name, avatar };
  });
  const recorded = ranked.some((row) => row.publicId === me.publicId);
  const others = ranked.length - (recorded ? 1 : 0) + players.length;
  if (others === 0) return null;

  // The player's unranked row, off their own result.
  const mine: PlayingRow | null = recorded
    ? null
    : {
        publicId: me.publicId,
        name: me.name,
        avatar: me.avatar,
        tries: me.tries,
        progress: me.ended ? me.progress : 100,
        over: me.ended,
      };
  // A day that fits the box is shown whole; the caps are for one that does not.
  const fits = ranked.length + players.length + (mine ? 1 : 0) <= RESULT_LINES_MAX;
  const { lines, shown } = rankedLines(ranked, me.publicId, fits);
  const room = fits ? players.length : Math.min(RESULT_PLAYING_MAX, RESULT_LINES_MAX - shown - (mine ? 1 : 0));
  const kept = new Set(
    orderPlaying(players)
      .slice(0, Math.max(0, room))
      .map((row) => row.publicId),
  );
  for (const row of orderPlaying(mine ? [...players, mine] : players)) {
    const own = row.publicId === me.publicId;
    if (own || kept.has(row.publicId)) lines.push({ kind: 'playing', row, me: own });
  }
  return { lines, more: ranked.length - shown + players.length - kept.size };
}

// The WORLD's day, off the global board: its top cut and the player's own window below it,
// which together run contiguous around the player. Nothing invented — a player with no
// recorded score sees the podium alone — and no count of the rest: the cut does not say how
// many there are.
export function worldResult(board: Board, meId: string): ResultBoard | null {
  const known = [...board.rows, ...(board.own ?? [])];
  if (known.length === 0) return null;
  return { lines: rankedLines(known, meId, known.length <= RESULT_LINES_MAX).lines, more: 0 };
}

// The block's tabs, in order: the group last opened first, then the player's other groups as the
// live read lists them, each only when somebody else has a row in it — then the WORLD.
export function resultTabs(
  live: LiveBoard | null,
  world: Board | null,
  lastGroupId: string | null,
  me: ResultMe,
): ResultTab[] {
  const tabs: ResultTab[] = [];
  if (live !== null) {
    const groups = [...live.groups].sort(
      (a, b) => Number(b.id === lastGroupId) - Number(a.id === lastGroupId),
    );
    for (const group of groups) {
      const board = groupResult(live, group, me);
      if (board) tabs.push({ key: group.id, group, board });
    }
  }
  if (world !== null) {
    const board = worldResult(world, me.publicId);
    if (board) tabs.push({ key: WORLD_TAB, group: null, board });
  }
  return tabs;
}
