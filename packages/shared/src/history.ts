// The PRIVATE player history (#211): what a summary surface may know about days it is not
// opening. #214 made the game network-dependent and removed the persisted sentence round,
// so the archive calendar, the language chooser and the streak have no local source left —
// this is the server-backed one they read instead.
//
// It is cross-package for the usual reason: the BACKEND derives these values from the round
// rows it already writes (#203's `progress`/`solved`) and the WEB renders them, so a second
// spelling of either the shape or the bound would let a calendar fill from numbers the
// server never meant.

// A month is addressed as `YYYY-MM` — the sort-key prefix a player's calendar is ONE Query
// over (`<lang>#<mode>#<month>-`, the order #203 established for exactly this read).
export const HISTORY_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

// One day of one (language, mode) as a summary surface sees it: never the raw guess log,
// only what the server already derived from it.
export interface HistoryDay {
  // The game day, "YYYY-MM-DD".
  date: string;
  // Reconstruction progress (0–100). A #214 CAPPED round stays UNSOLVED and keeps the
  // percentage it reached — the cap changes the result's headline, not the day's fill.
  progress: number;
  // The server has read this round's log as solved. Only ever written true (#203).
  solved: boolean;
}

// What the private history read answers. `days` is the asked-for month (EMPTY when no month
// was asked for — the streak needs no calendar); `solvedDays` is the language's solved-day
// collection, the raw fact the streak counters are derived from.
export interface PlayerHistory {
  days: HistoryDay[];
  solvedDays: number[];
}

// How many solved days one language keeps. It is a REBUILDABLE CACHE of the authoritative
// solved round rows, not a second authority, so bounding it costs nothing correct: no
// streak reaches back further than this, and `weekView` only ever reads the current week.
// The number is the one the web's persisted set used before #211 moved the collection to
// the server.
export const MAX_SOLVED_DAYS = 800;

// Sort ascending, drop duplicates, keep the most recent MAX_SOLVED_DAYS. Written once and
// applied on BOTH sides of the store — the write bounds what it keeps, the read bounds what
// it hands out — so a row that somehow grew past the cap still answers inside it.
export function boundSolvedDays(days: readonly number[]): number[] {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  return sorted.length > MAX_SOLVED_DAYS ? sorted.slice(-MAX_SOLVED_DAYS) : sorted;
}

// The CURRENT STREAK derived from a solved-day collection: the length of the consecutive
// run ending at the last solved day, but only while the chain is ALIVE — today is not yet
// required, so the last solve may be today (`activeDay`) or yesterday. Once it is older
// than yesterday the chain is broken and the streak is 0.
//
// It lives HERE since #204, where the SERVER first had to state one (the erase
// confirmation names what the account being deleted is about to lose, and a second
// spelling would put a different number on that dialog than the streak screen shows over
// the same days). The web's `game/streak.ts` derives its transition and week row from
// this one function.
//
// Order-independent and idempotent by construction — it normalizes its input — because the
// collection is a SET that is merged, never a sequence.
export function currentStreak(days: readonly number[], activeDay: number): number {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const last = sorted[sorted.length - 1];
  if (last < activeDay - 1) return 0; // chain broken — the last solve is older than yesterday
  let run = 1;
  for (let i = sorted.length - 1; i > 0; i--) {
    if (sorted[i] - sorted[i - 1] === 1) run++;
    else break;
  }
  return run;
}
