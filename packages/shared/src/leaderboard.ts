// The #190 leaderboard's ranking rules — the pure half of the board reads, shared
// because the BACKEND applies them (it cuts the global board and windows the caller's
// own row before profiles are attached) and the WEB renders what they produced (ranks
// on the friends board, the collapsed tie line, the own-row section). Two copies would
// let the ranks a board shows drift from the rows the server selected.
//
// Three decided rules (issue #190):
//   - TIES GET EQUAL RANKS, competition style, never a fake ordering. Sentence scores
//     are try counts, so ties dominate; breaking them by submission time would quietly
//     reward early timezones.
//   - THE GLOBAL BOARD IS A TOP-50 CUT, and a tie group STRADDLING the cut collapses
//     into one "+N at #rank" line rather than pretending position 50 means something
//     inside a tie.
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

export interface BoardOverflow {
  // The shared rank of the collapsed tie group, and how many players share it.
  rank: number;
  count: number;
}

export interface BoardCut {
  rows: RankedScore[];
  overflow: BoardOverflow | null;
}

// The top-of-board cut. Tie groups are kept WHOLE: groups are appended while they fit
// inside `limit`, and the first group that would cross the boundary collapses into the
// overflow line ("+N at #rank") instead of being truncated at an arbitrary member. A
// group that starts exactly AT the boundary is simply beyond the cut — a clean cut has
// no overflow line, because nothing was cut mid-tie.
export function cutBoard(ranked: readonly RankedScore[], limit = BOARD_TOP_LIMIT): BoardCut {
  const rows: RankedScore[] = [];
  let i = 0;
  while (i < ranked.length) {
    let j = i;
    while (j < ranked.length && ranked[j].score === ranked[i].score) j += 1;
    const size = j - i;
    if (rows.length + size > limit) {
      // Straddling the boundary collapses the whole group; starting past it is a clean cut.
      return {
        rows,
        overflow: rows.length < limit ? { rank: ranked[i].rank, count: size } : null,
      };
    }
    for (; i < j; i += 1) rows.push(ranked[i]);
  }
  return { rows, overflow: null };
}

// The caller's own row with `span` neighbors directly above and below (clamped at the
// board's edges). Null when the caller has no row on this board.
export function boardWindow(
  ranked: readonly RankedScore[],
  publicId: string,
  span = BOARD_WINDOW_SPAN,
): RankedScore[] | null {
  const index = ranked.findIndex((row) => row.publicId === publicId);
  if (index < 0) return null;
  return ranked.slice(Math.max(0, index - span), index + span + 1);
}

// What the global response actually carries for the caller: nothing when their row is
// already individually visible in the cut, otherwise their window MINUS any row the cut
// already shows (a row must never render twice because the window brushed the boundary).
export function boardOwnRows(
  ranked: readonly RankedScore[],
  cut: BoardCut,
  publicId: string,
  span = BOARD_WINDOW_SPAN,
): RankedScore[] | null {
  if (cut.rows.some((row) => row.publicId === publicId)) return null;
  const window = boardWindow(ranked, publicId, span);
  if (window === null) return null;
  const shown = new Set(cut.rows.map((row) => row.publicId));
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

export interface Board {
  // Recorded scores on this board today: the whole population for the global tab, the
  // caller's edges (plus themselves) for the friends tab.
  total: number;
  rows: BoardRow[];
  // The tie group collapsed at the global cut; always null on the friends board.
  overflow: BoardOverflow | null;
  // The caller's own below-the-cut window; always null on the friends board.
  own: BoardRow[] | null;
  // FRIENDS who have no recorded score today (user-decided 2026-08-20): an edge is a
  // person you chose, so the board names them even before they play — with "not played
  // yet" where a score would be, never by silently dropping the row. Always empty on
  // the global board (the population there IS the recorded scores), and never the
  // caller themselves (the identity strip already shows them).
  waiting: BoardPlayer[];
}
