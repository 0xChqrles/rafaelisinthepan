import type { DeviceAgent } from './deviceStore';
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
//
// **A WORD RUN BELONGS TO THE DEVICE THAT STARTED IT (#217).** The stamp names that device,
// and two conditions carry the whole model: a start is accepted only while the run is
// UNSUBMITTED (and then always mints a fresh clock, wiping what it replaces), and a
// submission only while the run is unsubmitted AND the stamp still names the caller. What
// that removes is the client-side inference #202 needed — a device could tell "I am running
// this" from "I merely joined it" only by remembering that its own start stamped the clock,
// and everything downstream hung off that memory.

export interface RoundKey {
  date: string;
  lang: string;
  mode: ScoreMode;
}

// WHICH DEVICE a word run belongs to (#217), stamped by the start that minted the clock.
// It carries the device's parsed user-agent FIELDS beside its id — a SNAPSHOT taken at the
// start, so the screen offering to end that run can name it ("Started on iPhone / Chrome")
// without a second lookup, and can still name it after that device has been signed out. The
// id is what the two conditions compare; the label is never read by a rule.
export interface RoundRunner extends DeviceAgent {
  deviceId: string;
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
  // WHO that clock belongs to (#217) — absent exactly when `startedAt` is, since one write
  // stamps both. Every answer carries it, because it is half of what the screen picks its
  // phase from: a run this device does not own is one it may neither play nor submit, and
  // the only thing it can do with the day is start it over.
  startedBy?: RoundRunner;
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
  // The device the run is being stamped FOR (#217) — the caller's own, resolved from its
  // token. It is written beside the clock and compared by the submission's condition.
  runner: RoundRunner;
  now: Date;
}

// What one word-round START did (#217, replacing #202's `started | running`):
//   started — the clock was stamped NOW, for THIS device. It is a RESTART as much as a
//             first start: an unsubmitted run — this device's, another device's, or the
//             retired puzzle's — is wiped and replaced, log and all. That is the whole
//             trade the issue makes: cross-device RESUME becomes cross-device RESTART,
//             because a run whose claims live in another device's local storage was never
//             resumable in the first place (Word mode streams nothing).
//   already_submitted — the run is RECORDED, so there is nothing left to restart: the
//             daily is one-shot once its log is stored. The caller adopts the final run
//             rather than wiping it.
export type RoundStartOutcome = 'started' | 'already_submitted';

export interface RoundSubmitInput extends RoundKey {
  publicId: string;
  puzzle: string;
  // The device claiming to have PLAYED this run (#217). A submission is accepted only
  // while the stamp still names it: a device whose run was restarted elsewhere has a log
  // for a clock that no longer exists, and recording it would bury the live run.
  deviceId: string;
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
//   started_elsewhere — the stamp names ANOTHER device (#217): this run was restarted
//                      while its player was away, so the log offered here belongs to a
//                      clock the server no longer has. Recording it would overwrite the
//                      run somebody is playing now, and first-write-wins would make that
//                      permanent. The caller adopts the answer and starts over.
//   too_early        — `now - startedAt` is under `minElapsedMs`: a run of this shape
//                      cannot be over yet;
//   already_submitted — first write wins, like a score row: the daily is one-shot and
//                      cannot be replayed, so a second submission changes nothing and is
//                      answered with the log that was recorded.
export type RoundSubmitOutcome =
  | 'submitted'
  | 'not_started'
  | 'started_elsewhere'
  | 'too_early'
  | 'already_submitted';

// What the friends board reads of one stored round (#206): the RAW ordered log (the
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

// One month of one (language, mode) for ONE player — the private calendar read (#211).
// The month is `YYYY-MM`, which is exactly a prefix of the sort key that #203 reordered
// for it: `<lang>#<mode>#<month>-` matches that game's days and nothing else.
export interface RoundMonthKey {
  lang: string;
  mode: ScoreMode;
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
  // FRIENDS_MAX + 1 callers per read.
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
  // appends: a refused append changes nothing and answers with the stored state, which is
  // already the truth the client reconciles against.
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
  // WORD mode's two writes (#202) — the mode streams nothing, because what syncing buys is
  // the live friends board and a 60-second run is over before anyone opens it.
  //
  // START stamps `startedAt` from the SERVER's clock on THIS record (never a separate
  // short-lived item: the submission can arrive hours later, on the revisit that finds the
  // run over) — and, since #217, the DEVICE it belongs to beside it. It is atomic and
  // unconditional except for the one thing that ends a daily: a RECORDED run is refused,
  // everything else is replaced.
  start(input: RoundStartInput): Promise<{ outcome: RoundStartOutcome; state: RoundState }>;
  // SUBMIT records the whole log at once, first-write-wins, no earlier than the run's own
  // floor, and only for the DEVICE the stamp names (#217). Like `append`, every outcome
  // answers with the stored state.
  submit(input: RoundSubmitInput): Promise<{ outcome: RoundSubmitOutcome; state: RoundState }>;
}

// A round key is only (date, lang, mode), so RE-PUBLISHING keeps the key while changing the
// puzzle. Without this tag the mount read would hand the RETIRED version's log straight back
// and undo the client's reset for good. So the record names its puzzle, a read for a
// different tag is an honest "nothing stored for this one", and an append carrying a
// different tag REPLACES the log rather than growing it.
//
// For a sentence it is the content-derived revision `publish` stamps onto the puzzle and
// slice; for Word mode the client derives it from the day's word. The server only compares
// the value, which is the same "stores strings, interprets nothing" rule the log follows.
// Bounded so a hostile value cannot bloat the item.
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

// The sort-key PREFIX one player's month sits behind (#211) — the same spelling as the key
// above, minus the day, which is the whole reason the order is lang#mode#date. The trailing
// dash is load-bearing: without it `2026-1` would also match `2026-10`.
export function roundMonthPrefix(key: RoundMonthKey): string {
  return `${key.lang}#${key.mode}#${key.month}-`;
}

// The formatters' one INVERSE: the DATE back out of a sort key the month prefix matched.
// Both stores used to restate this as hand-rolled offset arithmetic in their own coordinate
// systems, which compiles straight through a key reorder (#203 already made one) while
// silently emitting shifted date strings — every calendar cell missing its day with no
// error, and the memory store's tests passing because it made the same mistake. One
// spelling beside the formatters is what keeps the three in step.
export function roundSortKeyDate(sortKey: string, key: RoundMonthKey): string {
  return sortKey.slice(`${key.lang}#${key.mode}#`.length);
}
