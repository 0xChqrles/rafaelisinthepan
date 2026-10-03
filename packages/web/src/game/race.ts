// THE RACE LINE's reading (pure): the live read's members around the player, while they play.
//
// The order is the boards' own, never a second spelling: the members who FINISHED first, by
// score (fewest tries — `rankBoard`'s order), then everyone still PLAYING by the shared
// `orderPlaying` (closest to done, then fewer tries; a round that ended unsolved after every
// live one), with the PLAYER's own entry taken from the screen, not the server: their % off
// the board they see and their own try count, which are ahead of any stored summary. It is an
// ORDER, never a rank (#206: a position mid-round moves with every guess).
//
// The line shows a WINDOW of it, READ LEFT TO RIGHT FROM BELOW TO ABOVE: the one just behind
// the player, the player, the one just ahead — the two behind when they lead (both on their
// left), the two ahead when they trail (both on their right). `window` is in the line's own
// order, the lowest first. Null when nobody else has a row today: there is nobody to race.

import { orderPlaying, rankBoard, type LiveBoard } from '@whippin/shared';

interface Face {
  publicId: string;
  name: string;
  avatar: string | null;
}

export type RaceEntry =
  | (Face & { kind: 'done'; score: number })
  | (Face & { kind: 'playing' | 'over'; progress: number; tries: number; me: boolean });

export interface RaceMe {
  publicId: string;
  // The player's live reconstruction %, off the board they SEE (`computeProgress`).
  progress: number;
  tries: number;
}

export interface Race {
  // The whole order, the top first.
  entries: RaceEntry[];
  // The line, left to right: below the player to above.
  window: RaceEntry[];
}

const WINDOW = 3;

export function raceOf(live: LiveBoard, me: RaceMe): Race | null {
  const faces = new Map<string, Face>(
    [...live.rows, ...live.playing].map((row) => [
      row.publicId,
      { publicId: row.publicId, name: row.name, avatar: row.avatar },
    ]),
  );
  const faceOf = (publicId: string): Face => faces.get(publicId) ?? { publicId, name: '', avatar: null };

  const done: RaceEntry[] = rankBoard(live.rows.filter((row) => row.publicId !== me.publicId)).map(
    (row) => ({ ...faceOf(row.publicId), kind: 'done', score: row.score }),
  );
  const playing: RaceEntry[] = orderPlaying([
    ...live.playing.filter((row) => row.publicId !== me.publicId),
    { publicId: me.publicId, progress: me.progress, tries: me.tries, over: false },
  ]).map((row) => ({
    ...faceOf(row.publicId),
    kind: row.over ? 'over' : 'playing',
    progress: row.progress,
    tries: row.tries,
    me: row.publicId === me.publicId,
  }));
  const entries = [...done, ...playing];
  if (entries.length < 2) return null;

  const at = entries.findIndex((entry) => entry.kind !== 'done' && entry.me);
  const start = Math.min(Math.max(at - 1, 0), Math.max(entries.length - WINDOW, 0));
  return { entries, window: entries.slice(start, start + WINDOW).reverse() };
}

// The % a line prints: FLOORED, so 100% is only ever a solve — an unfinished 99.6 is 99%.
export function shownPercent(progress: number): number {
  return Math.floor(progress);
}
