import { describe, expect, it } from 'vitest';
import type { LiveBoard, LiveRow, PlayingRow } from '@whippin/shared';
import { raceOf, shownPercent, type RaceEntry } from './race';

// CONTRACT: the race line orders the live read the way the boards do — finished members
// first by score (the shared `rankBoard` order), then the playing ones by the shared
// `orderPlaying` (closest to done, fewer tries, publicId; ended-unsolved rounds last) — with
// the player's OWN entry taken from the screen, never their server row. The line shows the one
// just ahead, the player and the one just behind (two after when leading, two before when
// trailing), and nothing when nobody else has a row.

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
const live = (rows: LiveRow[], players: PlayingRow[]): LiveBoard => ({
  groups: [{ id: id('g'), name: 'G', members: [ME, ...rows.map((r) => r.publicId), ...players.map((r) => r.publicId)] }],
  rows,
  playing: players,
});
const ids = (entries: readonly RaceEntry[]) => entries.map((entry) => entry.publicId);

describe('raceOf', () => {
  it('replaces my server row with my LOCAL numbers', () => {
    const race = raceOf(live([], [playing(ME, 10, 3), playing(id('a'), 50, 9)]), {
      publicId: ME,
      progress: 75,
      tries: 12,
    });
    expect(race?.entries).toEqual([
      { publicId: ME, name: '', avatar: null, kind: 'playing', progress: 75, tries: 12, me: true },
      { publicId: id('a'), name: '', avatar: null, kind: 'playing', progress: 50, tries: 9, me: false },
    ]);
  });

  it('puts every finished member before every playing one, fewest tries first, and shows no % for them', () => {
    const race = raceOf(live([done(id('b'), 30), done(id('a'), 12)], [playing(id('c'), 99, 4)]), {
      publicId: ME,
      progress: 10,
      tries: 2,
    });
    expect(ids(race!.entries)).toEqual([id('a'), id('b'), id('c'), ME]);
    expect(race!.entries[0]).toEqual({ publicId: id('a'), name: '', avatar: null, kind: 'done', score: 12 });
  });

  it('orders the players by the shared rule: progress, then fewer tries, then id — ended rounds last', () => {
    const race = raceOf(
      live(
        [],
        [
          playing(id('a'), 79, 20),
          playing(id('b'), 79, 14),
          playing(id('c'), 67, 14),
          playing(id('d'), 95, 30, true),
        ],
      ),
      { publicId: ME, progress: 75, tries: 16 },
    );
    expect(ids(race!.entries)).toEqual([id('b'), id('a'), ME, id('c'), id('d')]);
    expect(race!.entries.at(-1)?.kind).toBe('over');
  });

  it('breaks an exact tie with me by tries, then id, like any other row', () => {
    const race = raceOf(live([], [playing(id('a'), 50, 8), playing(id('z'), 50, 8)]), {
      publicId: ME,
      progress: 50,
      tries: 8,
    });
    expect(ids(race!.entries)).toEqual([id('a'), ME, id('z')]);
  });

  it('windows one ahead, me, one behind', () => {
    const race = raceOf(
      live([done(id('a'), 10)], [playing(id('b'), 80, 5), playing(id('c'), 40, 5), playing(id('d'), 20, 5)]),
      { publicId: ME, progress: 60, tries: 5 },
    );
    expect(ids(race!.window)).toEqual([id('b'), ME, id('c')]);
  });

  it('shows the two behind when I lead, and the two ahead when I trail', () => {
    const others = [playing(id('a'), 80, 5), playing(id('b'), 40, 5), playing(id('c'), 20, 5)];
    expect(ids(raceOf(live([], others), { publicId: ME, progress: 90, tries: 5 })!.window)).toEqual([
      ME,
      id('a'),
      id('b'),
    ]);
    expect(ids(raceOf(live([], others), { publicId: ME, progress: 5, tries: 5 })!.window)).toEqual([
      id('b'),
      id('c'),
      ME,
    ]);
  });

  it('shows just the two of us when there is one other row', () => {
    expect(ids(raceOf(live([done(id('a'), 7)], []), { publicId: ME, progress: 30, tries: 9 })!.window)).toEqual([
      id('a'),
      ME,
    ]);
  });

  it('is NULL when nobody else has a row today', () => {
    expect(raceOf(live([], []), { publicId: ME, progress: 30, tries: 9 })).toBeNull();
    expect(raceOf(live([], [playing(ME, 30, 9)]), { publicId: ME, progress: 30, tries: 9 })).toBeNull();
    // My own finished row (a solve the server already recorded) is not somebody else.
    expect(raceOf(live([done(ME, 9)], []), { publicId: ME, progress: 100, tries: 9 })).toBeNull();
  });

  it('carries the faces the live read dressed', () => {
    const board = live([], [{ ...playing(id('a'), 50, 4), name: 'Zoe', avatar: 'A'.repeat(19) }]);
    const race = raceOf(board, { publicId: ME, progress: 10, tries: 1 });
    expect(race!.entries[0]).toMatchObject({ name: 'Zoe', avatar: 'A'.repeat(19) });
  });
});

describe('shownPercent', () => {
  it('floors, so 100% is only ever a solve', () => {
    expect(shownPercent(99.6)).toBe(99);
    expect(shownPercent(100)).toBe(100);
    expect(shownPercent(0)).toBe(0);
  });
});
