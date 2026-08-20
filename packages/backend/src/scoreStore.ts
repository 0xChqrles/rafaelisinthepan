import type { ScoreMode } from './scoreLimits';

export const SCORE_SUBMISSION_LIMIT = 5;
export const SCORE_DEDUP_TTL_SECONDS = 48 * 60 * 60;

export interface ScoreKey {
  date: string;
  lang: string;
  mode: ScoreMode;
}

// One recorded score per player per daily (#187): the row IS the population — the
// histogram, the percentile and the future leaderboard (#190) are all reads of a day's
// rows, so there is no second store to drift from.
export interface ScoreRow {
  publicId: string;
  score: number;
}

// What one submission did:
//   recorded — the row was written (and one IP allowance consumed);
//   already_recorded — the player already has a row for this daily. First write wins:
//     the daily cannot be replayed, so a second submission is never legitimate, and it
//     consumes no IP allowance;
//   capped — the hashed IP's volume allowance is exhausted; nothing changed.
export type ScoreSubmitOutcome = 'recorded' | 'already_recorded' | 'capped';

export interface ScoreSubmission extends ScoreKey {
  publicId: string;
  score: number;
  submittedAt: string;
  ipHash: string;
  expiresAt: number;
  requestToken: string;
}

export interface ScoreStore {
  // The whole day partition — small by construction (one row per player per daily).
  list(key: ScoreKey): Promise<ScoreRow[]>;
  // The rows of a KNOWN set of players — the friends board's read (#190): the caller
  // already holds the exact sort keys (its edges plus itself), so the store fetches
  // those directly instead of paging the whole day partition to keep at most
  // FRIENDS_MAX + 1 rows. A player with no recorded score simply has no row.
  getMany(key: ScoreKey, publicIds: readonly string[]): Promise<ScoreRow[]>;
  // The per-IP allowance and the row's first-write-wins condition are one atomic
  // decision: a refused submission (either outcome) changes neither item.
  submit(input: ScoreSubmission): Promise<ScoreSubmitOutcome>;
}

// Partition of a daily's score rows; the sort key is the row's publicId.
export function dayKey(key: ScoreKey): string {
  return `score#${key.date}#${key.lang}#${key.mode}`;
}

// The dedup item keeps its own partition so a day Query never reads allowance items.
export function dedupKey(key: ScoreKey, ipHash: string): string {
  return `dedup#${key.date}#${key.lang}#${key.mode}#${ipHash}`;
}

// The table now has a composite key, so single items carry a constant sort key.
export const DEDUP_SORT_KEY = 'dedup';
