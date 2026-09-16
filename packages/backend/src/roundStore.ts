import { EARLY_GUESS_CAP } from '@whippin/shared';

// The server-authoritative round record (#201): the RAW ordered guess log of one
// player's play on one daily. The log is stored as STRINGS — the folded forms the
// player actually tried — and the client interprets it (dedup, hole states, score);
// nothing here replays or scores anything. One item per (date, lang, publicId).
//
// The two bounds live in @whippin/shared (`ROUND_GUESS_CAP`, `ROUND_WRITE_MIN_MS`)
// because the web paces its flushes against the same numbers: the cap is enforced in
// the append write's own condition so it cannot be raced, and the interval is the
// per-player minimum between accepted writes (~1s between guesses). The client STREAMS
// into the log (`append`).

export interface RoundKey {
  date: string;
  lang: string;
}

export interface RoundState {
  guesses: string[];
  createdAt: string;
  // What the server DERIVED from the log beside it (#203), written in the same mutation
  // that appended the guesses — so nothing can half-fail and no stored summary can
  // disagree with the log it describes.
  //
  // `progress` is the reconstruction percentage (0-100). `solved` is ONLY EVER WRITTEN
  // TRUE and never cleared: a second device can append between this server's read and its
  // write, so the derived values may be computed from a log already one guess stale —
  // harmless for a percentage that self-corrects, fatal for a flag, since writing `false`
  // over a `true` another device just set would un-finish a finished day. Write-only-true
  // is also what makes it usable as the append condition's freeze.
  progress?: number;
  solved?: boolean;
}

// What one append did:
//   appended  — the batch joined the log (or REPLACED a retired puzzle's log, below);
//   too_fast  — the player wrote less than ROUND_WRITE_MIN_MS ago; nothing changed;
//   round_full — the batch would push the log past ROUND_GUESS_CAP; nothing changed;
//   round_solved — the round is already SOLVED and accepts no further appends (#203);
//                  nothing changed.
//   early_locked — the round is being played BEFORE its day (#273) and the night's play is
//                  over: the stored log has already made progress, or the batch would push
//                  it past EARLY_GUESS_CAP; nothing changed. The day itself unlocks it.
export type RoundAppendOutcome =
  | 'appended'
  | 'too_fast'
  | 'round_full'
  | 'round_solved'
  | 'early_locked';

export interface RoundAppendInput extends RoundKey {
  publicId: string;
  guesses: string[];
  // Which PUZZLE this log belongs to — an opaque client-supplied tag, compared for
  // EQUALITY and never interpreted (see `RoundStore` below).
  puzzle: string;
  // EARLY PLAY (#273): the round's date is AFTER the server's active day, so the append is
  // bounded twice more, inside the same condition — accepted only while the stored
  // `progress` is 0 AND the resulting log stays within `EARLY_GUESS_CAP`. The ROUTE decides
  // it (only it knows the server's day); the store enforces it, so it cannot be raced.
  early: boolean;
  // What the ROUTE derived from (the stored log + this batch) against the day's slice
  // (#203). It travels with the append because both must land in ONE mutation; the store
  // still knows nothing about what they mean.
  progress: number;
  solved: boolean;
  now: Date;
}

// The corrective write (#203). The append is atomic, but the read -> derive -> write
// SEQUENCE is not: the values it carried were computed from a snapshot taken before it,
// so deriving from *(my read + my batch)* misses a solve that exists only in the UNION of
// two concurrent batches. Stored log has all three holes open; device A's batch solves
// hole 3, device B's solves holes 1 and 2 — both read before either writes, both derive
// `solved: false`, both pass `attribute_not_exists(#solved)`, and the final log solves the
// puzzle while `solved` is never set. (A strongly consistent read behaves identically:
// both reads still precede both writes.)
//
// The append RETURNS the merged truth, so the fix needs no extra read: derive again from
// what came back and, when it disagrees, issue one small write. That fires once per round,
// only in the race, and costs nothing otherwise — writing the derived values back on EVERY
// append would double the write cost, since DynamoDB charges an update by the whole item
// size.
export interface RoundSettleInput extends RoundKey {
  publicId: string;
  puzzle: string;
  progress: number;
  solved: boolean;
}

// What a group board reads of one stored round (#206): the RAW ordered log (the
// route dedups it against the day's full artifact for the exact try count), the puzzle
// tag that says which published revision the log answers, and the derived summary the
// same row already carries (#203) — the stored `progress` is the one number the
// calendar shows for this day, so the board showing any other spelling of it would let
// the two disagree over the same log.
export interface RoundBoardRow {
  publicId: string;
  puzzle: string;
  guesses: string[];
  progress: number;
}

// One month of one language for ONE player — the private calendar read (#211). The month
// is `YYYY-MM`, which is exactly a prefix of the sort key that #203 reordered for it:
// `<lang>#sentence#<month>-` matches that language's days and nothing else.
export interface RoundMonthKey {
  lang: string;
  month: string;
}

// What a summary surface is told about one stored round: the two values the server already
// DERIVED from its log (#203), never the log. A row written before those existed (or one
// whose first append has not landed) reads as 0 / false — "nothing to show for this day",
// which is what an empty round is.
export interface RoundDaySummary {
  date: string;
  progress: number;
  solved: boolean;
}

export interface RoundStore {
  // ONE Query over a player's month (#211): the calendar's whole source, projected down to
  // the summary facts so the raw guess logs never leave the store. The rows are the days
  // that HAVE a record; a day with none is simply absent, which is how "not started" is
  // said. Never scoped to a puzzle REVISION: the calendar has no way to know which version
  // a past day is on, and a corrected round replaces the row on its own first append.
  listMonth(key: RoundMonthKey, publicId: string): Promise<RoundDaySummary[]>;
  // The stored rounds of a KNOWN set of players for one daily — the friends board's
  // read (#206), the exact shape the per-player partition was designed for: the caller
  // resolves its edges into row keys and fetches THOSE (BatchGetItem), never a read
  // across players. A player with no stored round simply has no row. Bounded by
  // GROUP_MEMBERS_MAX callers per read.
  getMany(key: RoundKey, publicIds: readonly string[]): Promise<RoundBoardRow[]>;
  // The caller's stored round, or null when the server holds none FOR THIS PUZZLE.
  //
  // `consistent` defaults to TRUE — the read normally lands right after this player's own
  // writes and must not be blind to them. #203's PRE-WRITE derivation read passes FALSE:
  // the only things derived from it are `progress`, which self-corrects on the next write
  // and is corrected against the append's own answer anyway, and `solved`, which is
  // write-only-true and so cannot regress on stale input. Every bound that must not be
  // raced lives in the write's own condition, not here, so an eventually consistent read
  // is enough — and it halves what the extra read costs.
  get(
    key: RoundKey,
    publicId: string,
    puzzle: string,
    opts?: { consistent?: boolean },
  ): Promise<RoundState | null>;
  // Append to the log (creating the item on the first write) under EVERY bound in one
  // atomic decision — including the #203 freeze, since a SOLVED round accepts no further
  // appends, and #273's early-play lock when the round is played before its day: a
  // refused append changes nothing and answers with the stored state, which is already the
  // truth the client reconciles against.
  append(input: RoundAppendInput): Promise<{ outcome: RoundAppendOutcome; state: RoundState }>;
  // Correct the derived summary against the log the append actually produced (#203). Only
  // ever called when the two disagree, and it must be RETRIED rather than fired and
  // forgotten: once a puzzle is solved the player stops guessing, so no later append will
  // come along to notice the omission. A record naming a different puzzle has nothing to
  // correct and is left alone.
  //
  // **`progress` is written UPWARD only**, the shape `solved` gets from being write-only-
  // true. Two settles can be in flight at once — this one sits behind a retry backoff, and
  // another device's append can land and settle inside it — so the later ARRIVAL may carry
  // the older log, and last-writer-wins would park a lower percentage on the row for good
  // (a solved round takes no further append to repair it). Progress only ever rises within
  // one puzzle's life, so refusing a lowering write costs nothing correct; a solve is never
  // refused by it, since a solved derivation is exactly 100.
  //
  // **It REPORTS whether the state it asked for is now the stored one** — true when the write
  // applied, FALSE when the condition refused it (found on review: swallowing that refusal
  // resolved the promise, and the route then claimed a solve the record had never taken,
  // because a concurrent republish had made it name another puzzle). A `false` is a VERDICT,
  // never a retry: a condition that refused once refuses again.
  //
  // **The APPEND is deliberately NOT guarded the same way**, so the stored percentage can
  // DIP for the moment between that write and this one: the append writes what the caller
  // derived from its own eventually-consistent read, which a concurrent device may already
  // have bettered. The dip is repaired by the settle that follows in the same request, off
  // the ALL_NEW log — and an unsolved round's next append would derive it correctly anyway,
  // so only the retry budget running out leaves it standing (already the logged failure
  // path). Guarding the append instead would REFUSE THE WHOLE WRITE in exactly that case:
  // a correct guess dropped to protect a value derived FROM it, which is the load-bearing
  // thing traded for the derived one. The append's job is to store guesses; the summary
  // rides along.
  settle(input: RoundSettleInput): Promise<boolean>;
}

// What the early-play bound (#273) refuses, read off the stored state of THIS puzzle: the
// night's play has already made progress, or this batch would push the log past
// `EARLY_GUESS_CAP`. It is the DynamoDB condition's two clauses restated for the
// classification read and for the memory store, so both backends refuse the same append.
export function earlyLocked(stored: RoundState, batch: number): boolean {
  return (stored.progress ?? 0) > 0 || stored.guesses.length + batch > EARLY_GUESS_CAP;
}

// A round key is only (date, lang), so RE-PUBLISHING keeps the key while changing the
// puzzle. Without this tag the mount read would hand the RETIRED version's log straight back
// and undo the client's reset for good. So the record names its puzzle, a read for a
// different tag is an honest "nothing stored for this one", and an append carrying a
// different tag REPLACES the log rather than growing it.
//
// It is the content-derived revision `publish` stamps onto the puzzle and slice. The server
// only compares the value, which is the same "stores strings, interprets nothing" rule the
// log follows.
// Bounded so a hostile value cannot bloat the item.
export const PUZZLE_TAG_SHAPE = /^[a-z0-9]{1,32}$/;

// Partition of one PLAYER's round records; the sort key names the daily. Per-player and
// not per-day: `append` rewrites the whole item (a DynamoDB list attribute has no partial
// update), so a long round's writes get progressively more expensive — and under a day
// partition every player's writes for one daily would land on ONE partition key, which
// adaptive capacity cannot split. Nothing reads across players here: /board resolves the
// group's members into exact row keys and fetches those (BatchGetItem), which is the
// shape a future progress read (#206) takes too.
export function roundPartition(publicId: string): string {
  return `round#${publicId}`;
}

// LANG, then DATE — reordered by #203 (it read `<date>#<lang>#…` in #201): #211 reads a
// player's calendar as ONE Query over a month, and with the date first a month prefix
// matched every language. A `FilterExpression` does not help, because DynamoDB filters
// AFTER reading: the cost and the 1 MB response limit are measured on what is READ.
//
// The middle `sentence` segment is a FIXED part of the key: it named the daily while Word
// mode stood beside it (retired 2026-09-16), and every stored round is addressed by it —
// dropping it would orphan every player's rounds, calendar and in-progress day.
const SORT_KEY_DAILY = 'sentence';

export function roundSortKey(key: RoundKey): string {
  return `${key.lang}#${SORT_KEY_DAILY}#${key.date}`;
}

// The sort-key PREFIX one player's month sits behind (#211) — the same spelling as the key
// above, minus the day, which is the whole reason the order is lang first and date last.
// The trailing dash is load-bearing: without it `2026-1` would also match `2026-10`.
export function roundMonthPrefix(key: RoundMonthKey): string {
  return `${key.lang}#${SORT_KEY_DAILY}#${key.month}-`;
}

// The formatters' one INVERSE: the DATE back out of a sort key the month prefix matched.
// Both stores used to restate this as hand-rolled offset arithmetic in their own coordinate
// systems, which compiles straight through a key reorder (#203 already made one) while
// silently emitting shifted date strings — every calendar cell missing its day with no
// error, and the memory store's tests passing because it made the same mistake. One
// spelling beside the formatters is what keeps the three in step.
export function roundSortKeyDate(sortKey: string, key: RoundMonthKey): string {
  return sortKey.slice(`${key.lang}#${SORT_KEY_DAILY}#`.length);
}
