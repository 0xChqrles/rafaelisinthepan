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
//   appended  — the batch joined the log (or REPLACED a retired puzzle's log, below);
//   too_fast  — the player wrote less than ROUND_WRITE_MIN_MS ago; nothing changed;
//   round_full — the batch would push the log past ROUND_GUESS_CAP; nothing changed.
export type RoundAppendOutcome = 'appended' | 'too_fast' | 'round_full';

export interface RoundAppendInput extends RoundKey {
  publicId: string;
  guesses: string[];
  // Which PUZZLE this log belongs to — an opaque client-supplied tag, compared for
  // EQUALITY and never interpreted (see `RoundStore` below).
  puzzle: string;
  now: Date;
}

export interface RoundStore {
  // The caller's stored round, or null when the server holds none FOR THIS PUZZLE.
  get(key: RoundKey, publicId: string, puzzle: string): Promise<RoundState | null>;
  // Append to the log (creating the item on the first write) under BOTH bounds in one
  // atomic decision: a refused append changes nothing and answers with the stored
  // state, which is already the truth the client reconciles against.
  append(input: RoundAppendInput): Promise<{ outcome: RoundAppendOutcome; state: RoundState }>;
}

// A round key is only (date, lang, mode), so RE-PUBLISHING a different sentence for the
// same daily keeps the key while changing the puzzle entirely — and the client resets its
// local round on exactly that (gameStore's `holesMatchPuzzle`). Without this tag the mount
// read would then hand the RETIRED sentence's log straight back and undo that reset, for
// good: every later read re-applies it. So the record names its puzzle, a read for a
// different tag is an honest "nothing stored for this one", and an append carrying a
// different tag REPLACES the log rather than growing it.
//
// The value is the CLIENT's (it is the only side that can see a sentence change under a
// key); the server only ever compares it, which is the same "stores strings, interprets
// nothing" rule the log itself follows. Bounded so a hostile value cannot bloat the item.
export const PUZZLE_TAG_SHAPE = /^[a-z0-9]{1,32}$/;

// Partition of one PLAYER's round records; the sort key names the daily. Per-player and
// not per-day: `append` rewrites the whole item (a DynamoDB list attribute has no partial
// update), so a long round's writes get progressively more expensive — and under a day
// partition every player's writes for one daily would land on ONE partition key, which
// adaptive capacity cannot split. Nothing reads across players here: /board resolves the
// caller's friends into exact row keys and fetches those (BatchGetItem), which is the
// shape a future progress read (#206) takes too.
export function roundPartition(publicId: string): string {
  return `round#${publicId}`;
}

export function roundSortKey(key: RoundKey): string {
  return `${key.date}#${key.lang}#${key.mode}`;
}
