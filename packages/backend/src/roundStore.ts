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
//
// SENTENCE mode STREAMS into that log (`append`). WORD mode writes exactly TWICE (#202):
// a Turnstile-gated `start` that stamps the server's own clock onto this same record, and
// one end-of-run `submit` carrying the whole log. Neither word path touches
// `lastWriteAt` — that attribute exists for the streaming interval, and a mode that writes
// twice a day is not what it bounds.

export interface RoundKey {
  date: string;
  lang: string;
  mode: ScoreMode;
}

export interface RoundState {
  guesses: string[];
  createdAt: string;
  // What the server DERIVED from the log beside it (#203), written in the same mutation
  // that appended the guesses — so nothing can half-fail and no stored summary can
  // disagree with the log it describes. Sentence rounds only: a word round is "done", not
  // solved, and `submittedAt` already says so.
  //
  // `progress` is the reconstruction percentage (0-100). `solved` is ONLY EVER WRITTEN
  // TRUE and never cleared: a second device can append between this server's read and its
  // write, so the derived values may be computed from a log already one guess stale —
  // harmless for a percentage that self-corrects, fatal for a flag, since writing `false`
  // over a `true` another device just set would un-finish a finished day. Write-only-true
  // is also what makes it usable as the append condition's freeze.
  progress?: number;
  solved?: boolean;
  // WORD mode's clock (#202): the instant the SERVER stamped this round's start, ISO. It
  // is the anchor the run's whole deadline hangs off, which is why the server owns it —
  // a client-supplied one is simply backdated and the wait check below evaporates.
  // Absent on a sentence round, and on a word round nobody has started.
  //
  // A STRING, like `createdAt` and unlike `lastWriteAt`: the Number spelling is reserved
  // for the one attribute a DynamoDB CONDITION compares arithmetically, and this one is
  // compared in the handler, after a read it has to do anyway.
  startedAt?: string;
  // When the word round's end-of-run log was RECORDED (#202). It is the submission's own
  // marker, and it has to be: a run that claimed nothing submits an EMPTY log, which is
  // indistinguishable from an unsubmitted one by the log alone. Inferring it from
  // `guesses.length` let a second submission overwrite a recorded empty run, made a retry
  // of one classify as `not_started` — a client VERDICT, so the conversation closed — and
  // left a mount read unable to see that the day was already recorded.
  submittedAt?: string;
}

// What one append did:
//   appended  — the batch joined the log (or REPLACED a retired puzzle's log, below);
//   too_fast  — the player wrote less than ROUND_WRITE_MIN_MS ago; nothing changed;
//   round_full — the batch would push the log past ROUND_GUESS_CAP; nothing changed;
//   round_solved — the round is already SOLVED and accepts no further appends (#203);
//                  nothing changed.
export type RoundAppendOutcome = 'appended' | 'too_fast' | 'round_full' | 'round_solved';

export interface RoundAppendInput extends RoundKey {
  publicId: string;
  guesses: string[];
  // Which PUZZLE this log belongs to — an opaque client-supplied tag, compared for
  // EQUALITY and never interpreted (see `RoundStore` below).
  puzzle: string;
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

export interface RoundStartInput extends RoundKey {
  publicId: string;
  puzzle: string;
  now: Date;
}

// What one word-round START did:
//   started — the clock was stamped NOW (a fresh round, or one restarted because the
//             stored record named a RETIRED puzzle — its log goes with it);
//   running — this puzzle's round was already stamped, so its ORIGINAL start stands.
//             Idempotent by construction: a double tap, a retry and a second device all
//             resume the one clock rather than minting a second one.
export type RoundStartOutcome = 'started' | 'running';

export interface RoundSubmitInput extends RoundKey {
  publicId: string;
  puzzle: string;
  guesses: string[];
  // The shortest this run can possibly have lasted, in ms (`wordRunFloorMs` over the
  // claims the log carries). The ROUTE computes it, because only it can tell a claim from
  // a miss — that needs the day's artifact, which this store knows nothing about.
  minElapsedMs: number;
  now: Date;
}

// What one word-round SUBMIT did:
//   submitted        — the whole log was recorded;
//   not_started      — no round of this puzzle has a server-stamped start, so there is
//                      nothing to end;
//   too_early        — `now - startedAt` is under `minElapsedMs`: a run of this shape
//                      cannot be over yet;
//   already_submitted — first write wins, like a score row: the daily is one-shot and
//                      cannot be replayed, so a second submission changes nothing and is
//                      answered with the log that was recorded.
export type RoundSubmitOutcome = 'submitted' | 'not_started' | 'too_early' | 'already_submitted';

export interface RoundStore {
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
  // appends: a refused append changes nothing and answers with the stored state, which is
  // already the truth the client reconciles against.
  append(input: RoundAppendInput): Promise<{ outcome: RoundAppendOutcome; state: RoundState }>;
  // Correct the derived summary against the log the append actually produced (#203). Only
  // ever called when the two disagree, and it must be RETRIED rather than fired and
  // forgotten: once a puzzle is solved the player stops guessing, so no later append will
  // come along to notice the omission. A record naming a different puzzle has nothing to
  // correct and is left alone.
  settle(input: RoundSettleInput): Promise<void>;
  // WORD mode's two writes (#202) — the mode streams nothing, because what syncing buys is
  // the live friends board and a 60-second run is over before anyone opens it.
  //
  // START stamps `startedAt` from the SERVER's clock on THIS record (never a separate
  // short-lived item: the submission can arrive hours later, on the revisit that finds the
  // run over).
  start(input: RoundStartInput): Promise<{ outcome: RoundStartOutcome; state: RoundState }>;
  // SUBMIT records the whole log at once, first-write-wins, no earlier than the run's own
  // floor. Like `append`, every outcome answers with the stored state.
  submit(input: RoundSubmitInput): Promise<{ outcome: RoundSubmitOutcome; state: RoundState }>;
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

// LANG, MODE, then DATE — reordered by #203 (it read `<date>#<lang>#<mode>` in #201).
//
// It lands here rather than in #211, which is what actually needs it, because this is the
// first issue to write `progress`/`solved` onto round rows and reordering afterwards would
// mean those rows had been written under two schemes. What it buys: #211 reads a player's
// calendar as ONE Query over a month, and with the date first a month prefix matches every
// language and every mode — up to ~124 rows for one calendar. Reordered,
// `fr#sentence#2026-08-` returns exactly one game's month, about 31 rows. A
// `FilterExpression` does not help, because DynamoDB filters AFTER reading: the cost and
// the 1 MB response limit are measured on what is READ, and at 5-10 KB a round row ~124
// rows can cross it and paginate where ~31 cannot. No migration — the archive is wiped
// before launch and back-compat is not kept.
export function roundSortKey(key: RoundKey): string {
  return `${key.lang}#${key.mode}#${key.date}`;
}
