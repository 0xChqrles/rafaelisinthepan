import { describe, expect, it } from 'vitest';
import type { Board, BoardRow, PeriodBoard, PeriodRow, PlayingRow } from '@whippin/shared';
import { hasLines, listCounts, ownLineKey, podiumShows, type ShownBoard } from './boardView';

// The board screen's readings decide what a reader sees of their own day: the ghost and its
// INVITE where nobody else is there (never over a board that has somebody), your line found
// wherever it stands, and a podium that builds again only when what it shows changed.
const ME = 'me';
const face = (publicId: string) => ({ publicId, name: publicId, avatar: null });
const ranked = (publicId: string, rank: number, score: number): BoardRow => ({ ...face(publicId), rank, score });
const playing = (publicId: string): PlayingRow => ({ ...face(publicId), tries: 12, progress: 40, over: false });
const day = (over: Partial<Board> = {}): Board => ({ rows: [], own: null, playing: [], waiting: [], ...over });
const period = (rows: PeriodRow[]): PeriodBoard => ({ from: '2026-09-28', to: '2026-10-03', rows });
const pts = (publicId: string, rank: number, points: number, solvedDays = 2, total = 40): PeriodRow => ({
  ...face(publicId),
  rank,
  points,
  solvedDays,
  total,
});

describe('hasLines — the empty board is per tab, and never a board with somebody else on it', () => {
  it('a group of one is empty, even once you played: your own row alone is "nobody else yet"', () => {
    expect(hasLines(day(), 'group', ME)).toBe(false);
    expect(hasLines(day({ rows: [ranked(ME, 1, 20)] }), 'group', ME)).toBe(false);
    expect(hasLines(day({ playing: [playing(ME)] }), 'group', ME)).toBe(false);
  });

  it('a member who has not played, or one still playing, is somebody: the board has lines', () => {
    expect(hasLines(day({ rows: [ranked(ME, 1, 20)], waiting: [face('a')] }), 'group', ME)).toBe(true);
    expect(hasLines(day({ playing: [playing('a')] }), 'group', ME)).toBe(true);
  });

  it('GLOBAL is empty only when nobody played — your own row there is a line', () => {
    expect(hasLines(day(), 'global', ME)).toBe(false);
    expect(hasLines(day({ rows: [ranked(ME, 1, 20)] }), 'global', ME)).toBe(true);
    expect(hasLines(day({ own: [ranked(ME, 61, 90)] }), 'global', ME)).toBe(true);
  });

  it('a week or a month is empty when nobody recorded a score in it', () => {
    expect(hasLines(period([]), 'group', ME)).toBe(false);
    expect(hasLines(period([pts(ME, 1, 3)]), 'group', ME)).toBe(true);
  });
});

describe('listCounts — the lines carry numbers', () => {
  it('only when a row has one: members who have not played carry none', () => {
    expect(listCounts(day({ waiting: [face('a')] }))).toBe(false);
    expect(listCounts(day({ playing: [playing('a')] }))).toBe(true);
    expect(listCounts(day({ own: [ranked(ME, 61, 90)] }))).toBe(true);
    expect(listCounts(period([pts('a', 1, 3)]))).toBe(true);
  });
});

describe('ownLineKey — where your line is, so the held edge watches it again when it moves', () => {
  const shown = (board: Board | PeriodBoard): ShownBoard => ({ key: 'k', board, tab: 'group' });

  it('names your rank, in the list or in your own window below the cut', () => {
    expect(ownLineKey(shown(day({ rows: [ranked('a', 1, 9), ranked(ME, 2, 14)] })), ME)).toBe('r2');
    expect(ownLineKey(shown(day({ own: [ranked(ME, 61, 90)] })), ME)).toBe('r61');
    expect(ownLineKey(shown(period([pts(ME, 3, 1)])), ME)).toBe('p3');
  });

  it('says playing while your round is on, and nothing when you are not on the board', () => {
    expect(ownLineKey(shown(day({ playing: [playing(ME)] })), ME)).toBe('playing');
    expect(ownLineKey(shown(day({ waiting: [face('a')] })), ME)).toBe('');
    expect(ownLineKey(shown(day({ rows: [ranked(ME, 1, 9)] })), null)).toBe('');
    expect(ownLineKey(null, ME)).toBe('');
  });
});

describe('podiumShows — one picture per state, a new scene only when the podium changed', () => {
  const show = (shown: ShownBoard | null, over: { failed?: boolean; none?: boolean; mates?: string[] } = {}) =>
    podiumShows({
      failed: over.failed ?? false,
      none: over.none ?? false,
      shown,
      meId: ME,
      mates: new Set(over.mates ?? []),
      lang: 'en',
    });
  const board = (b: Board | PeriodBoard, tab: 'group' | 'global' = 'group'): ShownBoard => ({ key: 'g:day', board: b, tab });

  it('a failure, no group, a read still out and an empty board are each their own picture', () => {
    expect(show(null, { failed: true }).mode).toBe('failed');
    expect(show(null, { none: true }).mode).toBe('ghost');
    expect(show(null).mode).toBe('loading');
    const empty = show(board(day({ rows: [ranked(ME, 1, 20)] })));
    expect(empty.mode).toBe('ghost');
    expect(empty.places).toEqual([null, null, null]);
  });

  it('stands the first three rows on the places, each value in its unit', () => {
    const shown = show(board(day({ rows: [ranked('a', 1, 1), ranked(ME, 2, 14)] })));
    expect(shown.mode).toBe('board');
    expect(shown.places.map((p) => p && [p.player.publicId, p.value, p.unit, p.me])).toEqual([
      ['a', 1, 'TRY', false],
      [ME, 14, 'TRIES', true],
      null,
    ]);
    const week = show(board(period([pts('a', 1, 6), pts('b', 2, 1)])));
    expect(week.places.map((p) => p?.unit ?? null)).toEqual(['POINTS', 'POINT', null]);
  });

  it('a week\'s days and tries changing alone draw the same scene: its points are all it shows', () => {
    const before = show(board(period([pts('a', 1, 6, 2, 40), pts('b', 2, 3, 2, 50)])));
    const after = show(board(period([pts('a', 1, 6, 3, 61), pts('b', 2, 3, 3, 80)])));
    expect(after.build).toBe(before.build);
    expect(show(board(period([pts('a', 1, 9), pts('b', 2, 3)]))).build).not.toBe(before.build);
  });

  it('marks one of your people on GLOBAL only (on a group\'s board every row is one)', () => {
    const rows = [ranked('a', 1, 9), ranked('b', 2, 14)];
    expect(show(board(day({ rows }), 'global'), { mates: ['b'] }).places.map((p) => p?.mate ?? null)).toEqual([
      false,
      true,
      null,
    ]);
    expect(show(board(day({ rows })), { mates: ['b'] }).places.map((p) => p?.mate ?? null)).toEqual([false, false, null]);
  });
});
