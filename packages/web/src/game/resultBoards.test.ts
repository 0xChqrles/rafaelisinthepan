import { describe, expect, it } from 'vitest';
import type { Board, BoardRow, LiveBoard, LiveGroup, LiveRow, PlayingRow } from '@whippin/shared';
import {
  RESULT_LINES_MAX,
  WORLD_TAB,
  groupResult,
  resultTabs,
  worldResult,
  type ResultBoard,
  type ResultMe,
} from './resultBoards';

// CONTRACT (the solved screen's boards): ONE group at a time, its finished members ranked by
// the shared `rankBoard` over that group's own members, then its playing members by the shared
// `orderPlaying` (ended-unsolved last). Shown: the whole day when it fits the box, else the
// podium + the player's ±1 window (their row always in), a few playing rows, a count of the
// rest — never more than RESULT_LINES_MAX rows.
// The player's own row comes from their own result: ranked only when their score is recorded,
// `∞` among the ended when the round ended unsolved, an unranked finished row otherwise — never
// a false rank. A group where nobody else has a row is skipped. Tabs: the group last opened
// first, then the others, then the WORLD (the global board: podium + own window, nothing
// invented).

const ME = 'mmmmmmmmmmmmmmmm';
const id = (c: string) => c.repeat(16);

const done = (publicId: string, score: number): LiveRow => ({ publicId, score, name: '', avatar: null });
const playing = (publicId: string, progress: number, tries: number, over = false): PlayingRow => ({
  publicId,
  progress,
  tries,
  over,
  name: '',
  avatar: null,
});
const group = (members: string[], key = 'g', name = 'G'): LiveGroup => ({ id: id(key), name, members });
const live = (groups: LiveGroup[], rows: LiveRow[], players: PlayingRow[]): LiveBoard => ({
  groups,
  rows,
  playing: players,
});
const solvedMe = (tries: number): ResultMe => ({ publicId: ME, name: 'Me', avatar: null, tries, progress: 100, ended: false });
const endedMe = (tries: number, progress: number): ResultMe => ({
  publicId: ME,
  name: 'Me',
  avatar: null,
  tries,
  progress,
  ended: true,
});

// The board as a list of readable tokens: `#rank id` for a ranked row (`*` on mine), `~` for a
// gap, `% id` for a playing row (`∞` when it ended).
function read(board: ResultBoard | null): string[] {
  if (board === null) return [];
  return board.lines.map((line) => {
    if (line.kind === 'gap') return '~';
    const star = line.me ? '*' : '';
    if (line.kind === 'ranked') return `#${line.row.rank} ${line.row.publicId[0]}${star}`;
    return `${line.row.over ? '∞' : `${line.row.progress}%`} ${line.row.publicId[0]}${star}`;
  });
}

describe('groupResult', () => {
  it('ranks the group by tries with competition ties and marks my recorded row', () => {
    const g = group([ME, id('a'), id('b'), id('c')]);
    const board = groupResult(live([g], [done(id('a'), 12), done(ME, 9), done(id('b'), 12), done(id('c'), 30)], []), g, solvedMe(9));
    expect(read(board)).toEqual(['#1 m*', '#2 a', '#2 b', '#4 c']);
    expect(board?.more).toBe(0);
  });

  it('ranks only THIS group: a member of another of my groups never shows in it', () => {
    const mine = group([ME, id('a')], 'g');
    const other = group([ME, id('z')], 'h');
    const board = groupResult(
      live([mine, other], [done(id('z'), 3), done(id('a'), 20), done(ME, 10)], [playing(id('y'), 50, 4)]),
      mine,
      solvedMe(10),
    );
    expect(read(board)).toEqual(['#1 m*', '#2 a']);
  });

  it('shows the podium and my ±1 window with a gap between, and counts the rest', () => {
    const others = 'abcdefghijk'.split('');
    const g = group([ME, ...others.map(id)]);
    const rows = [...others.map((c, i) => done(id(c), 3 + i * 2)), done(ME, 16)];
    const board = groupResult(live([g], rows, []), g, solvedMe(16));
    // a=3 b=5 c=7 d=9 e=11 f=13 g=15 | me=16 | h=17 i=19 j=21 k=23
    expect(read(board)).toEqual(['#1 a', '#2 b', '#3 c', '~', '#7 g', '#8 m*', '#9 h']);
    expect(board?.more).toBe(12 - 6);
  });

  it('runs the podium into my window without a gap when they touch', () => {
    const g = group([ME, id('a'), id('b'), id('c'), id('d'), id('e'), id('f')]);
    const rows = [3, 4, 5, 7, 8, 9].map((score, i) => done(id('abcdef'[i]), score));
    const board = groupResult(live([g], [...rows, done(ME, 6)], []), g, solvedMe(6));
    expect(read(board)).toEqual(['#1 a', '#2 b', '#3 c', '#4 m*', '#5 d']);
    expect(board?.more).toBe(2);
  });

  it("shows a small group's whole day when it fits the box: every rank, every player", () => {
    const g = group([ME, id('a'), id('b'), id('c'), id('d'), id('e')]);
    const board = groupResult(
      live(
        [g],
        [done(id('a'), 4), done(ME, 8), done(id('b'), 9)],
        [playing(id('c'), 30, 7, true), playing(id('d'), 50, 12), playing(id('e'), 70, 20)],
      ),
      g,
      solvedMe(8),
    );
    expect(read(board)).toEqual(['#1 a', '#2 m*', '#3 b', '70% e', '50% d', '∞ c']);
    expect(board?.more).toBe(0);
  });

  it('puts the playing members after the ranked ones by the shared order, ended ones last, capped', () => {
    const g = group([ME, id('a'), id('b'), id('c'), id('d'), id('e'), id('f')]);
    const board = groupResult(
      live(
        [g],
        [done(id('e'), 5), done(id('f'), 6), done(ME, 8)],
        [playing(id('a'), 40, 9, true), playing(id('b'), 79, 20), playing(id('c'), 67, 14), playing(id('d'), 79, 14)],
      ),
      g,
      solvedMe(8),
    );
    // Live first (closest to done, then fewer tries), the given-up `a` last — and only two shown.
    expect(read(board)).toEqual(['#1 e', '#2 f', '#3 m*', '79% d', '79% b']);
    expect(board?.more).toBe(2);
  });

  it('draws my ENDED round as ∞ among the ended rows, from my own result, never ranked', () => {
    const g = group([ME, id('a'), id('b')]);
    const board = groupResult(
      live([g], [done(id('a'), 15)], [playing(id('b'), 60, 30), playing(ME, 20, 5)]),
      g,
      endedMe(42, 71),
    );
    expect(read(board)).toEqual(['#1 a', '60% b', '∞ m*']);
    const mine = board!.lines[2];
    expect(mine).toEqual({
      kind: 'playing',
      me: true,
      row: { publicId: ME, name: 'Me', avatar: null, tries: 42, progress: 71, over: true },
    });
  });

  it('draws my solve with NO recorded score as an unranked finished row (no false rank)', () => {
    const g = group([ME, id('a'), id('b')]);
    // The read still carries my mid-round row from before the solve: my own result replaces it.
    const board = groupResult(
      live([g], [done(id('a'), 15), done(id('b'), 40)], [playing(ME, 80, 10)]),
      g,
      solvedMe(22),
    );
    expect(read(board)).toEqual(['#1 a', '#2 b', '100% m*']);
    expect(board!.lines.every((line) => line.kind !== 'ranked' || !line.me)).toBe(true);
    expect(board!.lines[2]).toMatchObject({ row: { tries: 22, over: false } });
  });

  it('always keeps my row in, and never draws more than the box holds', () => {
    const many = 'abcdefghijklnopq'.split('');
    const g = group([ME, ...many.map(id)]);
    // a..h score 3, 5, … 17; i..q are playing.
    const rows = many.slice(0, 8).map((c, i) => done(id(c), 3 + i * 2));
    const players = many.slice(8).map((c, i) => playing(id(c), 90 - i, 10 + i));
    // Ended, behind every live player.
    const board = groupResult(live([g], rows, players), g, endedMe(500, 12));
    const shown = board!.lines.filter((line) => line.kind !== 'gap');
    expect(shown.length).toBeLessThanOrEqual(RESULT_LINES_MAX);
    expect(read(board)).toEqual(['#1 a', '#2 b', '#3 c', '90% i', '89% j', '∞ m*']);
    expect(board!.more).toBe(5 + 6);

    // Deep in a long ranking: the podium and the window fill the box, no playing row fits.
    const deep = groupResult(live([g], [...rows, done(ME, 14)], players), g, solvedMe(14));
    expect(read(deep)).toEqual(['#1 a', '#2 b', '#3 c', '~', '#6 f', '#7 m*', '#8 g']);
    expect(deep!.more).toBe(3 + players.length);
  });

  it('skips a group where nobody but me has a row', () => {
    const g = group([ME, id('a')]);
    expect(groupResult(live([g], [done(ME, 9)], []), g, solvedMe(9))).toBeNull();
    expect(groupResult(live([g], [], [playing(ME, 30, 4, true)]), g, endedMe(4, 30))).toBeNull();
  });
});

describe('worldResult', () => {
  const ranked = (c: string, rank: number, score = rank + 2): BoardRow => ({
    publicId: id(c),
    name: '',
    avatar: null,
    score,
    rank,
  });
  const board = (rows: BoardRow[], own: BoardRow[] | null = null): Board => ({ rows, own, playing: [], waiting: [] });
  const meRow = (rank: number): BoardRow => ({ publicId: ME, name: '', avatar: null, score: rank + 2, rank });

  it('shows the podium and my window inside the cut', () => {
    const rows = [ranked('a', 1), ranked('b', 2), ranked('c', 3), ranked('d', 4), meRow(5), ranked('e', 6)];
    expect(read(worldResult(board(rows), ME))).toEqual(['#1 a', '#2 b', '#3 c', '#4 d', '#5 m*', '#6 e']);
  });

  it('reaches my own window below the cut, with a gap', () => {
    const cut = 'abcdefghij'.split('').map((c, i) => ranked(c, i + 1));
    const own = [ranked('x', 79), meRow(80), ranked('y', 81)];
    const world = worldResult(board(cut, own), ME);
    expect(read(world)).toEqual(['#1 a', '#2 b', '#3 c', '~', '#79 x', '#80 m*', '#81 y']);
    // The cut does not say how many there are: no count.
    expect(world?.more).toBe(0);
  });

  it('invents nothing for a player with no recorded score: the podium alone', () => {
    const cut = 'abcdefghij'.split('').map((c, i) => ranked(c, i + 1));
    expect(read(worldResult(board(cut), ME))).toEqual(['#1 a', '#2 b', '#3 c']);
    expect(worldResult(board([]), ME)).toBeNull();
  });
});

describe('resultTabs', () => {
  const g1 = group([ME, id('a')], 'g', 'One');
  const g2 = group([ME, id('b')], 'h', 'Two');
  const lonely = group([ME, id('c')], 'k', 'Lonely');
  const answer = live([g1, lonely, g2], [done(id('a'), 5), done(id('b'), 7), done(ME, 9)], []);
  const world: Board = {
    rows: [{ publicId: id('w'), name: '', avatar: null, score: 3, rank: 1 }],
    own: null,
    playing: [],
    waiting: [],
  };

  it('puts the group last opened first, skips the empty ones, and ends on the WORLD', () => {
    expect(resultTabs(answer, world, id('h'), solvedMe(9)).map((tab) => tab.key)).toEqual([id('h'), id('g'), WORLD_TAB]);
    expect(resultTabs(answer, world, null, solvedMe(9)).map((tab) => tab.key)).toEqual([id('g'), id('h'), WORLD_TAB]);
  });

  it('shows the WORLD alone without groups, and no WORLD without its read', () => {
    expect(resultTabs(null, world, null, solvedMe(9)).map((tab) => tab.key)).toEqual([WORLD_TAB]);
    expect(resultTabs(answer, null, null, solvedMe(9)).map((tab) => tab.group?.name)).toEqual(['One', 'Two']);
    expect(resultTabs(null, null, null, solvedMe(9))).toEqual([]);
  });
});
