// The #190 leaderboard's ranking rules — the pure half of the board reads, shared
// because the BACKEND applies them (it cuts the global board and windows the caller's
// own row before profiles are attached) and the WEB renders what they produced (ranks
// on a group's board, the own-row section). Two copies would
// let the ranks a board shows drift from the rows the server selected. Since #271 the
// PERIOD rule (`rankPeriod`, at the bottom) ranks a group's WEEK and MONTH the same way,
// once, for both ends.
//
// Three decided rules (issue #190; the cut simplified 2026-08-20 on user review):
//   - TIES GET EQUAL RANKS, competition style, never a fake ordering. Sentence scores
//     are try counts, so ties dominate; breaking them by submission time would quietly
//     reward early timezones.
//   - THE GLOBAL BOARD IS A PLAIN TOP-50 CUT: at most 50 rows, ties displayed as
//     ordinary rows sharing their rank — a tie crossing the boundary is simply cut
//     like anything else (the issue's original "+N at #rank" collapse was built and
//     then removed on the user's call: fold nothing).
//   - A CALLER OUTSIDE THE CUT still sees their own row with the two neighbors directly
//     above and below.

// Which way is BETTER is the mode's (the standing line's own rule): sentence counts
// tries — lower is better — and Word counts claims, higher is better.
export type BoardMode = 'sentence' | 'word';

export interface BoardScore {
  publicId: string;
  score: number;
}

export interface RankedScore extends BoardScore {
  // Competition ranking: everyone strictly ahead, plus one — a whole tie group shares it.
  rank: number;
}

// The global tab shows this many individually named rows at most.
export const BOARD_TOP_LIMIT = 50;

// How many neighbors flank the caller's own row on each side when it sits below the cut.
export const BOARD_WINDOW_SPAN = 2;

// Sort a day's rows best-first and assign competition ranks. Ties are ordered by
// publicId — NOT a ranking claim (they share the rank), only a deterministic row order
// so two reads of one population never shuffle the board between them.
export function rankBoard(rows: readonly BoardScore[], mode: BoardMode): RankedScore[] {
  const sorted = [...rows].sort((a, b) => {
    const byScore = mode === 'word' ? b.score - a.score : a.score - b.score;
    if (byScore !== 0) return byScore;
    return a.publicId < b.publicId ? -1 : a.publicId > b.publicId ? 1 : 0;
  });
  let rank = 1;
  return sorted.map((row, i) => {
    if (i > 0 && row.score !== sorted[i - 1].score) rank = i + 1;
    return { publicId: row.publicId, score: row.score, rank };
  });
}

// The top-of-board cut: the first BOARD_TOP_LIMIT rows, nothing folded (user-decided
// 2026-08-20, superseding the straddling-tie collapse) — a tie crossing the boundary
// shows whichever members sit inside it, each at the shared rank.
export function cutBoard(ranked: readonly RankedScore[]): RankedScore[] {
  return ranked.slice(0, BOARD_TOP_LIMIT);
}

// The caller's own row with BOARD_WINDOW_SPAN neighbors directly above and below
// (clamped at the board's edges). Null when the caller has no row on this board.
export function boardWindow(
  ranked: readonly RankedScore[],
  publicId: string,
): RankedScore[] | null {
  const index = ranked.findIndex((row) => row.publicId === publicId);
  if (index < 0) return null;
  return ranked.slice(Math.max(0, index - BOARD_WINDOW_SPAN), index + BOARD_WINDOW_SPAN + 1);
}

// One member STILL PLAYING the daily (#206): the two live numbers a mid-round row
// shows — the EXACT deduped try count (the same `countTries` the score records, never
// the raw stored log length: two devices can store one identity twice, and a member
// must not watch 40 all afternoon and see the final score land at 38) and the server's
// derived reconstruction percentage (#203's stored value, the calendar's own source).
export interface PlayingScore {
  publicId: string;
  tries: number;
  progress: number;
}

// The in-progress rows' order — "ranked among themselves", below every finished row,
// which is an ORDER and never a rank claim (a mid-round position moves with every
// guess, so the rows carry no rank number): closest to done first, fewer tries breaking
// the tie (fewer is the score that would record), publicId last for a deterministic
// board between reads — `rankBoard`'s own tie rule.
export function orderPlaying(rows: readonly PlayingScore[]): PlayingScore[] {
  return [...rows].sort((a, b) => {
    if (a.progress !== b.progress) return b.progress - a.progress;
    if (a.tries !== b.tries) return a.tries - b.tries;
    return a.publicId < b.publicId ? -1 : a.publicId > b.publicId ? 1 : 0;
  });
}

// What the global response actually carries for the caller: nothing when their row is
// already visible in the cut, otherwise their window MINUS any row the cut already
// shows (a row must never render twice because the window brushed the boundary).
export function boardOwnRows(
  ranked: readonly RankedScore[],
  cut: readonly RankedScore[],
  publicId: string,
): RankedScore[] | null {
  if (cut.some((row) => row.publicId === publicId)) return null;
  const window = boardWindow(ranked, publicId);
  if (window === null) return null;
  const shown = new Set(cut.map((row) => row.publicId));
  return window.filter((row) => !shown.has(row.publicId));
}

// ---- The board as the API speaks it (#190): ranked rows dressed with the public
// profile a board renders (#188). `avatar` is null for a player who never customized;
// `name` may be empty for the same reason (the client falls back to a pseudonym
// derived from the publicId).

export interface BoardPlayer {
  publicId: string;
  name: string;
  avatar: string | null;
}

export interface BoardRow extends BoardPlayer {
  score: number;
  rank: number;
}

// A dressed in-progress row (#206): the `PlayingScore` numbers with the profile a board
// renders. No rank — the section's order is `orderPlaying`'s, and a mid-round position
// is never a rank claim.
export interface PlayingRow extends BoardPlayer {
  tries: number;
  progress: number;
}

export interface Board {
  rows: BoardRow[];
  // The caller's own below-the-cut window; always null on a group's board.
  own: BoardRow[] | null;
  // GROUP MEMBERS mid-round today (#206), in `orderPlaying`'s order: the board is alive
  // while the day is still being played, instead of only filling in once everybody
  // finished. MEMBERS ONLY, always empty on the global board — a membership is consented
  // by construction; strangers watching you play is not the same thing. Sentence mode
  // only in practice: a Word run is 60 seconds plus bonuses, over before anyone looks,
  // and its log reaches the server only at submission anyway.
  playing: PlayingRow[];
  // MEMBERS who have no recorded score today (user-decided 2026-08-20): a member is a
  // person in a group you chose, so the board names them even before they play — with
  // "not played yet" where a score would be, never by silently dropping the row. Always
  // empty on the global board (the population there IS the recorded scores), and never
  // the caller themselves (the header's own face already shows them).
  waiting: BoardPlayer[];
}

// ---- A group's WEEK / MONTH (#271, user-decided 2026-09-07): ONE rule, applied by the
// backend over the recorded score rows of every day in the range and rendered by the web.
//
//   1. PODIUM POINTS per day: each day is ranked on its own (`rankBoard`, competition
//      ties), and the first three RANKS pay 3 / 2 / 1 — a tie for first pays both 3,
//      and the next rank is then third (1), the competition rule's own arithmetic.
//   2. then SOLVED DAYS — how many days of the range recorded a score at all;
//   3. then the TOTAL of the recorded scores, in the mode's own direction (sentence:
//      fewer tries; Word: more words);
//   4. publicId last — a deterministic row order, never a ranking claim (`rankBoard`'s
//      own tie rule). Rows equal on all three numbers share their rank.
//
// A day with no recorded score for a member is simply absent from that member's line —
// a leaderboard is a DAY's competition (#211's on-time rule), so late and capped rounds
// count for nothing here exactly as they record no row on the day board.
export const PODIUM_POINTS: readonly number[] = [3, 2, 1];

// One recorded score of one member on one day of the range — what the backend reads.
export interface PeriodDay extends BoardScore {
  date: string;
}

export interface PeriodScore {
  publicId: string;
  points: number;
  solvedDays: number;
  total: number;
}

export interface RankedPeriod extends PeriodScore {
  rank: number;
}

function podiumPoints(rank: number): number {
  return PODIUM_POINTS[rank - 1] ?? 0;
}

export function rankPeriod(days: readonly PeriodDay[], mode: BoardMode): RankedPeriod[] {
  const byDate = new Map<string, PeriodDay[]>();
  for (const day of days) {
    const rows = byDate.get(day.date) ?? [];
    rows.push(day);
    byDate.set(day.date, rows);
  }
  const totals = new Map<string, PeriodScore>();
  for (const rows of byDate.values()) {
    for (const row of rankBoard(rows, mode)) {
      const held = totals.get(row.publicId) ?? {
        publicId: row.publicId,
        points: 0,
        solvedDays: 0,
        total: 0,
      };
      held.points += podiumPoints(row.rank);
      held.solvedDays += 1;
      held.total += row.score;
      totals.set(row.publicId, held);
    }
  }
  const sorted = [...totals.values()].sort((a, b) => {
    if (a.points !== b.points) return b.points - a.points;
    if (a.solvedDays !== b.solvedDays) return b.solvedDays - a.solvedDays;
    if (a.total !== b.total) return mode === 'word' ? b.total - a.total : a.total - b.total;
    return a.publicId < b.publicId ? -1 : a.publicId > b.publicId ? 1 : 0;
  });
  let rank = 1;
  return sorted.map((row, i) => {
    const previous = sorted[i - 1];
    if (
      i > 0 &&
      (row.points !== previous.points ||
        row.solvedDays !== previous.solvedDays ||
        row.total !== previous.total)
    ) {
      rank = i + 1;
    }
    return { ...row, rank };
  });
}

// Where the caller stands on one group's DAY board (#271): their competition rank among
// the members who recorded a score today, and how many did — "2nd of 7 today". Null when
// the caller has no recorded score on that board (not finished, finished late, capped),
// which the solved screen draws as nothing.
export interface Standing {
  rank: number;
  of: number;
}

export function standingIn(ranked: readonly RankedScore[], publicId: string): Standing | null {
  const own = ranked.find((row) => row.publicId === publicId);
  return own ? { rank: own.rank, of: ranked.length } : null;
}

// What `POST /board {token, standing: true}` answers, one entry per group of the caller's
// in which they stand today. The solved screen picks ONE (the group last opened, else the
// best), so the whole set travels in one request.
export interface GroupStanding extends Standing {
  group: string;
}

// A dressed period row: the ranked numbers with the profile a board renders.
export interface PeriodRow extends BoardPlayer, RankedPeriod {}

// What `POST /board {token, group, period}` answers for a WEEK or a MONTH: the ranked
// members who recorded at least one score in the range, and the range itself (ISO
// dates, inclusive) so the screen can caption what it is showing.
export interface PeriodBoard {
  from: string;
  to: string;
  rows: PeriodRow[];
}
