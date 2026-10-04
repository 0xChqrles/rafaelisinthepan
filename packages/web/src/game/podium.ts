// THE PODIUM'S PICK (pure): which of a board's ranked rows stand on the leaderboard's podium
// and which are lines under it — and, for each place, the two numbers the scene draws.
//
// The podium is the FIRST THREE ROWS in the server's order (the rows come ranked: competition
// ties, the shared `rankBoard` / `rankPeriod`), never a re-ranking: a place carries its row's
// own rank, so a tie for first puts two rank-1 rows on the podium and both stand on a first
// place's step. Every other ranked row is a line, in order, and nothing is dropped: the
// podium plus the lines are the rows, each exactly once. A board with fewer than three rows
// leaves the remaining places EMPTY (their steps stand with nobody on them, a dash for a
// value).
//
// `near` is how close a place is to the best on the board, 0–100 — the heat ink its aura
// rises in (the progress reading of `progressHeatColor`: 100 the calm cobalt). A day board
// counts TRIES, fewer being better, so it is the best score over this one; a WEEK or a MONTH
// counts podium POINTS, more being better, so it is these points over the best.

export interface PodiumPlace<T> {
  row: T;
  // The row's own rank (the step's height follows it, `stepTier`).
  rank: number;
  // The number its caption carries: the tries, or the period's points.
  value: number;
  near: number;
}

export interface PodiumPick<T> {
  // First, second, third — in rank order; null where nobody stands.
  places: [PodiumPlace<T> | null, PodiumPlace<T> | null, PodiumPlace<T> | null];
  lines: T[];
}

export const PODIUM_PLACES = 3;

function pick<T extends { rank: number }>(
  rows: readonly T[],
  value: (row: T) => number,
  near: (row: T, best: T) => number,
): PodiumPick<T> {
  const best = rows[0];
  const place = (i: number): PodiumPlace<T> | null => {
    const row = rows[i];
    if (row === undefined || best === undefined) return null;
    return { row, rank: row.rank, value: value(row), near: Math.max(0, Math.min(100, near(row, best))) };
  };
  return { places: [place(0), place(1), place(2)], lines: rows.slice(PODIUM_PLACES) };
}

// A DAY: the tries, and the best tries over these (a score is at least one try).
export function dayPodium<T extends { rank: number; score: number }>(rows: readonly T[]): PodiumPick<T> {
  return pick(
    rows,
    (row) => row.score,
    (row, best) => (100 * Math.max(1, best.score)) / Math.max(1, row.score),
  );
}

// A WEEK or a MONTH: the points, and these points over the best (the first row always holds
// some: a ranked day pays its first rank 3).
export function periodPodium<T extends { rank: number; points: number }>(rows: readonly T[]): PodiumPick<T> {
  return pick(
    rows,
    (row) => row.points,
    (row, best) => (best.points > 0 ? (100 * row.points) / best.points : 0),
  );
}

// A step's height class: a first rank stands on the tallest, a second on the middle one, and
// anything below on the lowest — a tie keeps its rank, so two firsts stand equally tall.
export function stepTier(rank: number): 0 | 1 | 2 {
  return rank <= 1 ? 0 : rank === 2 ? 1 : 2;
}
