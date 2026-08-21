import type { ScoreMode } from './scoreLimits';

// The server-authoritative round record (#201): the RAW ordered guess log of one
// player's play on one daily. The log is stored as STRINGS — the folded forms the
// player actually tried — and the client interprets it (dedup, hole states, score);
// nothing here replays or scores anything. One item per (date, lang, mode, publicId).
//
// The two bounds live in @whippin/shared (`ROUND_GUESS_CAP`, `ROUND_WRITE_MIN_MS`)
// because the web paces its flushes against the same numbers: the cap is enforced in
// the append write's own condition so it cannot be raced, and the interval is the
// per-player minimum between accepted writes (~1s between guesses).

export interface RoundKey {
  date: string;
  lang: string;
  mode: ScoreMode;
}

export interface RoundState {
  guesses: string[];
  createdAt: string;
}

// What one append did:
//   appended  — the batch joined the log;
//   too_fast  — the player wrote less than ROUND_WRITE_MIN_MS ago; nothing changed;
//   round_full — the batch would push the log past ROUND_GUESS_CAP; nothing changed.
export type RoundAppendOutcome = 'appended' | 'too_fast' | 'round_full';

export interface RoundAppendInput extends RoundKey {
  publicId: string;
  guesses: string[];
  now: Date;
}

export interface RoundStore {
  // The caller's stored round, or null when the server holds none yet.
  get(key: RoundKey, publicId: string): Promise<RoundState | null>;
  // Append to the log (creating the item on the first write) under BOTH conditions in
  // one atomic decision: a refused append changes nothing and answers with the stored
  // state, which is already the truth the client reconciles against.
  append(input: RoundAppendInput): Promise<{ outcome: RoundAppendOutcome; state: RoundState }>;
}

// Partition of a daily's round records; the sort key is the record's publicId. A day
// partition groups everyone who played that daily, which is exactly what a future
// progress read over the logs (#206) will Query.
export function roundPartition(key: RoundKey): string {
  return `round#${key.date}#${key.lang}#${key.mode}`;
}
