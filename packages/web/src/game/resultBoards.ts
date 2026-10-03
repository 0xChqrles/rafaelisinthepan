// THE RESULT'S BOARDS (pure): how the player's finished day compares, under SHARE — each of
// their groups in turn off the live read (`state/liveBoard.ts`), then the GLOBAL board. A few
// rows each, in a box of one fixed size, so the block can hold its footprint before any read
// lands and a swipe between groups moves nothing under it.
//
// ONE group's lines are the boards' own reading, never a second spelling: the members who
// RECORDED a score today ranked by the shared `rankBoard` (a rank belongs to one group, so the
// live read's merged rows are cut by the group's member list first), then the members still
// playing by the shared `orderPlaying` (an ended-unsolved round after every live one). Shown: the
// whole day when it fits the box; otherwise the podium (the first three ranked rows), the
// player's own row with the one just ahead and the one just behind, up to two of the playing
// rows — and the box FILLED, never left half empty: the room those leave goes to the next rows
// down the ranking, then to more playing rows — and how many rows that left out (`more`).
//
// THE PLAYER'S OWN ROW comes from their own result, never from a guess: ranked when the server
// recorded their score; otherwise an unranked playing row — `∞` when the round ended unsolved, a
// finished 100% when it was solved with no recorded score (late, or refused by the IP floor) —
// which never claims a rank. The GLOBAL tab invents nothing: no recorded score, no own row.

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
  // A group's id, or `GLOBAL_TAB`.
  key: string;
  // The group, or null for the GLOBAL board.
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

export const GLOBAL_TAB = 'global';
// The box's rows: a podium and a window of three, or a podium, the player and two playing.
export const RESULT_LINES_MAX = 6;
// The playing rows a group shows besides the player's own.
export const RESULT_PLAYING_MAX = 2;
const PODIUM = 3;

// The ranked rows a box shows (indices, best-first): every one when `room` holds them all;
// else the podium and the player's ±1 window (`at`, -1 when unranked), then the next rows down
// the ranking while room is left — a player near the top fills the box with the rows under the
// podium rather than leave it half empty. A player deep in the ranking leaves no room: the
// podium and their window are the box.
function pickRanked(count: number, at: number, room: number): number[] {
  const keep = new Set<number>();
  if (count <= room) {
    for (let i = 0; i < count; i += 1) keep.add(i);
  } else {
    for (let i = 0; i < Math.min(PODIUM, count); i += 1) keep.add(i);
    if (at >= 0) {
      for (const i of [at - 1, at, at + 1]) if (i >= 0 && i < count) keep.add(i);
    }
    for (let i = 0; i < count && keep.size < room; i += 1) keep.add(i);
  }
  return [...keep].sort((a, b) => a - b);
}

// Those rows as lines, a gap where two shown ones do not touch.
function rankedLines(ranked: readonly BoardRow[], picked: readonly number[], at: number): ResultLine[] {
  const lines: ResultLine[] = [];
  let last = -1;
  for (const i of picked) {
    if (last >= 0 && i > last + 1) lines.push({ kind: 'gap' });
    lines.push({ kind: 'ranked', row: ranked[i], me: i === at });
    last = i;
  }
  return lines;
}

// Whether a live answer was read AFTER the player's round ended: the server's own row for them
// says so — their recorded score, or a round over (ended unsolved) or complete (a 100% is only
// ever a solve; one with no score row is late or refused by the IP floor). An answer read
// before the end still carries them mid-round, and drawing the groups off it would leave out
// the score their solve just recorded: the result waits for a newer one.
export function liveSawEnd(live: LiveBoard, publicId: string): boolean {
  if (live.rows.some((row) => row.publicId === publicId)) return true;
  const own = live.playing.find((row) => row.publicId === publicId);
  return own !== undefined && (own.over || own.progress >= 100);
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
  // A day that fits the box is shown whole; the caps are for one that does not. The ranked rows
  // come first, leaving the playing rows their few; what the ranking cannot fill goes to more
  // playing rows.
  const own = mine ? 1 : 0;
  const ordered = orderPlaying(players);
  const at = ranked.findIndex((row) => row.publicId === me.publicId);
  const picked = pickRanked(ranked.length, at, RESULT_LINES_MAX - own - Math.min(RESULT_PLAYING_MAX, ordered.length));
  const lines = rankedLines(ranked, picked, at);
  const kept = new Set(
    ordered
      .slice(0, Math.max(0, RESULT_LINES_MAX - own - picked.length))
      .map((row) => row.publicId),
  );
  for (const row of orderPlaying(mine ? [...players, mine] : players)) {
    const isMe = row.publicId === me.publicId;
    if (isMe || kept.has(row.publicId)) lines.push({ kind: 'playing', row, me: isMe });
  }
  return { lines, more: ranked.length - picked.length + players.length - kept.size };
}

// The GLOBAL board's day: its top cut and the player's own window below it,
// which together run contiguous around the player. Nothing invented — a player with no
// recorded score sees the top of the board alone — and no count of the rest: the cut does not
// say how many there are.
export function globalResult(board: Board, meId: string): ResultBoard | null {
  const known = [...board.rows, ...(board.own ?? [])];
  if (known.length === 0) return null;
  const at = known.findIndex((row) => row.publicId === meId);
  return { lines: rankedLines(known, pickRanked(known.length, at, RESULT_LINES_MAX), at), more: 0 };
}

// The block's tabs, in order: the group last opened first, then the player's other groups as the
// live read lists them, each only when somebody else has a row in it — then the GLOBAL board.
export function resultTabs(
  live: LiveBoard | null,
  globalBoard: Board | null,
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
  if (globalBoard !== null) {
    const board = globalResult(globalBoard, me.publicId);
    if (board) tabs.push({ key: GLOBAL_TAB, group: null, board });
  }
  return tabs;
}
