// Word mode's conversation with the server (#202). The mode writes exactly TWICE, where
// sentence mode streams (state/roundSync.ts):
//
//   PLAY  -> START:  a Turnstile-gated write that stamps this round's clock from the
//                    SERVER's own clock. The visible countdown does not begin until the
//                    reply lands, so what the player watches and what the server measures
//                    are the same run.
//   clock -> SUBMIT: ONE post carrying the whole log, at the end of the run — including a
//            dies    run whose tab died mid-clock, which submits on the revisit that finds
//                    it over.
//
// The intuition says the opposite (fast game, urgent sync), but the fast game benefits
// LEAST: what syncing buys is the live friends board (#206), and a 60-second run is over
// before anybody opens it. Write counts are roughly a wash between the modes, so value
// decides the shape rather than cost.
//
// The server's clock is not about cheat prevention — the day's artifact is public and
// anyone determined can type its words — but about the end-of-run WAIT CHECK having an
// anchor the client cannot move: a client-supplied start is simply backdated and the bound
// evaporates. What the client keeps is an ELAPSED SPAN translated into its own clock
// (`anchorFrom`), never the server's instant, so a device whose clock is minutes off still
// runs a 60-second run.
//
// The mount READ is the third message and it writes nothing: it is what makes the daily
// one-shot ACROSS DEVICES (closing the tab mid-run and opening another device resumes the
// same clock instead of starting a fresh run) and what carries a finished day's recorded
// run to a device that never played it.
//
// One conversation per round lives in a MODULE-level map, the sentence engine's own
// pattern: a ref would not survive a real unmount, and neither the queue nor the in-flight
// write may be duplicated by a remount (archive round-trips, StrictMode).

import { totalBonus, replayWordRun, rankEntry, CLAIM_ZONE } from '../game/wordGame';
import { ROUND_WRITE_MIN_MS, WORD_MISS_CAP, type WordRanks } from '@whippin/shared';
import { parseRound, postRoundBody, roundUrl, type RoundState } from '../api';
import { fnvTag } from './roundSync';
import { useGameStore } from './gameStore';
import { playerSecret } from '../identity';
import { turnstileToken } from '../turnstile';

export interface WordRoundContext {
  roundKey: string;
  lang: string;
  date: string;
  // The day's word slug — this daily's puzzle identity, the way the hole signature is the
  // sentence's. A republished different word restarts the round on both ends.
  word: string;
  ranks: WordRanks;
  // The existence set's size: what a claim's seconds are priced against (#163), and
  // therefore what an ADOPTED log's deadline is re-derived from.
  corpusSize: number;
}

interface WordFlight extends WordRoundContext {
  puzzle: string;
  // The mount read has landed (or 404'd).
  readDone: boolean;
  // The run is over and its log has not been acknowledged yet.
  wantSubmit: boolean;
  failures: number;
  lastFailureAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
  closed: boolean;
}

const flights = new Map<string, WordFlight>();

// One start per round at a time: a double tap on PLAY, or React replaying an effect, must
// not mint two challenges and two writes. The server's start is idempotent per puzzle
// anyway — this is what keeps the CLIENT from asking twice.
const starts = new Map<string, Promise<boolean>>();

// Which rounds THIS SESSION started (PLAY was tapped here and the server stamped a clock).
// It is what tells a run this device PLAYED from one it merely joined: a second device — or
// a second tab holding a stale copy — anchors the server's `startedAt` with an empty log and
// no way to know what the real run has claimed, so its clock dies at the bare START_SECONDS
// and it declares a run OVER that is still being played elsewhere. Writing there would
// record an EMPTY run over the real one, permanently, since both the round log and the score
// row are first-write-wins.
//
// Session-scoped rather than persisted, deliberately: the flag exists to say "I am the one
// playing this right now", and a reload has no claim to that. What it costs is one honest
// case — a run that claimed NOTHING and whose tab died before the deadline records no log —
// against a joining device silently destroying a real run's score, which is the worse
// outcome by a distance. Keyed off the round rather than the flight so a flight evicted by
// `pruneFlights` (an archive detour mid-run) does not lose it.
const startedHere = new Set<string>();

// Did this session start this round's run? Read by the SCREEN too: the same rule gates the
// day's score submission, which is first-write-wins in exactly the same way.
export function startedRunHere(roundKey: string): boolean {
  return startedHere.has(roundKey);
}

// May this device write a run it is about to call finished? Yes when it has a log of its
// own — that is a run somebody played here — and yes for the session that started the run,
// which is what lets a real 0-claim run record. Never for a joiner holding nothing.
function mayWrite(roundKey: string, tried: readonly string[]): boolean {
  return tried.length > 0 || startedRunHere(roundKey);
}

// Bound the map, the sentence engine's rule: every flight pins its artifact's whole rank
// map. Evicting is safe by construction — durability lives in the persisted round, so a
// dropped conversation resumes on that round's next mount, with a read.
const MAX_FLIGHTS = 3;

// Ceiling on the retry window, so an outage cannot spin a request a second.
const MAX_BACKOFF_MS = 30_000;

// Which WORD a round's state belongs to — the tag the server stores beside it and only
// ever compares. Same encoding as the sentence tag, over the signature this daily has.
export function wordTag(word: string): string {
  return fnvTag(`w:${word}`);
}

// This device's clock for a run the SERVER timed. The answer carries both the stamp and the
// server's own `now`, so what travels is an elapsed span both ends agree on rather than an
// instant one of them would misread. The request's own travel time lands INSIDE the run —
// the anchor is that much later than the true start — which is exactly the margin that
// keeps an honest submission clear of the server's wait check.
export function anchorFrom(state: RoundState, now: number = Date.now()): number | null {
  if (state.startedAt === null) return null;
  const elapsed = Date.parse(state.now) - Date.parse(state.startedAt);
  return now - Math.max(0, elapsed);
}

// What of a run's log the server will store. Claims are bounded by the FIELD (a group can
// be claimed once, and there are at most CLAIM_ZONE of them), so only the misses can run
// away — a 67-minute maxed run has time for thousands. The client truncates its own log to
// what the route accepts rather than posting a batch it can only be refused for; the local
// log keeps everything, because the post-mortem board draws the whole run.
export function submittableLog(ranks: WordRanks, tried: readonly string[]): string[] {
  const log: string[] = [];
  let misses = 0;
  for (const typed of tried) {
    const entry = rankEntry(ranks, typed);
    if (entry && entry.rank >= 1 && entry.rank <= CLAIM_ZONE) {
      log.push(typed);
      continue;
    }
    if (misses >= WORD_MISS_CAP) continue;
    misses += 1;
    log.push(typed);
  }
  return log;
}

// How long a failed attempt waits before the next one: the write interval doubled per
// consecutive failure, up to the ceiling. Pure, and injected `now`, so the schedule is
// asserted without sleeping. (The sentence engine's `backoffDelayMs`, which this mode has
// no reason to spell differently.)
export function backoffDelayMs(failures: number, lastFailureAt: number, now: number): number {
  if (failures === 0) return 0;
  const windowMs = Math.min(ROUND_WRITE_MIN_MS * 2 ** failures, MAX_BACKOFF_MS);
  return Math.max(0, lastFailureAt + windowMs - now);
}

function schedule(key: string, delay: number) {
  const f = flights.get(key);
  if (!f || f.closed || f.timer !== null) return;
  // Global setTimeout, not window's: the engine also runs under node in tests.
  f.timer = setTimeout(() => {
    f.timer = null;
    void pump(key);
  }, delay);
}

function pruneFlights(keep: string): void {
  for (const [key, f] of flights) {
    if (flights.size <= MAX_FLIGHTS) return;
    if (key === keep || f.inFlight) continue;
    if (f.timer !== null) clearTimeout(f.timer);
    flights.delete(key);
  }
}

// Register a word round's context (WordGame mounts one per round) and drive its
// conversation. `over` is the run's own end — a wall-clock fact this engine cannot see for
// itself — and it is what asks for the one end-of-run write.
export function beginWordRoundSync(ctx: WordRoundContext, over: boolean): void {
  const puzzle = wordTag(ctx.word);
  const existing = flights.get(ctx.roundKey);
  if (existing) {
    // A different word republished UNDER an open conversation: everything the flight knows
    // describes the retired one, so the conversation starts over — `wantSubmit` INCLUDED.
    // It is a fact about the RETIRED run ("it ended and its log is unsent"), and carrying
    // it across would make the fresh round's first act a submission of the empty log the
    // reset just gave it: refused `not_started`, treated as the verdict it would be for a
    // round nobody started, and the conversation closed for the session — so the word the
    // player then actually plays never syncs at all.
    const restarted = existing.puzzle !== puzzle;
    if (restarted) {
      existing.readDone = false;
      existing.closed = false;
      existing.failures = 0;
    }
    Object.assign(existing, ctx, {
      puzzle,
      wantSubmit: restarted ? over : existing.wantSubmit || over,
    });
    // Re-insert so the LRU sees this round as the most recent.
    flights.delete(ctx.roundKey);
    flights.set(ctx.roundKey, existing);
    pruneFlights(ctx.roundKey);
    void pump(ctx.roundKey);
    return;
  }
  flights.set(ctx.roundKey, {
    ...ctx,
    puzzle,
    readDone: false,
    wantSubmit: over,
    failures: 0,
    lastFailureAt: 0,
    timer: null,
    inFlight: null,
    closed: false,
  });
  pruneFlights(ctx.roundKey);
  void pump(ctx.roundKey);
}

// PLAY: ask the server to stamp this round's clock, and report whether it did. The screen
// awaits it — the gate holds a loading state until the answer lands, which is what removes
// the skew that starting optimistically would build in: the server would stamp `startedAt`
// an RTT LATER than the visible clock began and therefore see LESS elapsed time than the
// player did, refusing a legitimate run submitting right at its deadline — intermittently,
// on slow connections only, and miserable to diagnose.
export function startWordRound(ctx: WordRoundContext): Promise<boolean> {
  const pending = starts.get(ctx.roundKey);
  if (pending) return pending;
  const flight = requestStart(ctx).finally(() => {
    if (starts.get(ctx.roundKey) === flight) starts.delete(ctx.roundKey);
  });
  starts.set(ctx.roundKey, flight);
  return flight;
}

async function requestStart(ctx: WordRoundContext): Promise<boolean> {
  const puzzle = wordTag(ctx.word);
  let response: Response;
  try {
    // The invisible challenge (web/turnstile.ts) — every failure rejects quietly, and here
    // that is a start the player is told about rather than a silent one: the run cannot
    // begin without it.
    const token = await turnstileToken();
    response = await postRoundBody(roundUrl(ctx.lang, ctx.date, 'word'), {
      secret: playerSecret(),
      puzzle,
      turnstileToken: token,
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;
  let state: RoundState;
  try {
    state = parseRound(await response.json());
  } catch {
    return false;
  }
  const startedAt = anchorFrom(state);
  if (startedAt === null) return false;
  // `running` is answered 200 too: a second tap, a retry or another device resumes the ONE
  // clock the server already stamped, and the store's anchor is idempotent besides.
  startedHere.add(ctx.roundKey);
  useGameStore.getState().anchorWordRun(ctx.roundKey, startedAt);
  adoptState(ctx, state);
  return true;
}

async function pump(key: string): Promise<void> {
  const f = flights.get(key);
  if (!f || f.closed || f.inFlight) return;

  const round = useGameStore.getState().wordRounds[key];
  if (!round) return;

  const wantsWrite = f.wantSubmit && !round.submitted && mayWrite(key, round.tried);
  if (f.readDone && !wantsWrite) return; // nothing left to say

  const now = Date.now();
  const delay = backoffDelayMs(f.failures, f.lastFailureAt, now);
  if (delay > 0) {
    schedule(key, delay);
    return;
  }

  f.inFlight = f.readDone ? submitRun(f, key, round.tried) : readRound(f, key);
  try {
    await f.inFlight;
  } catch {
    // Neither leg is expected to throw — both own their own error paths — but an
    // unexpected one must not escape as an unhandled rejection, and above all must not
    // leave `inFlight` pinned: that wedges this conversation shut for the tab's life.
    retryLater(f);
  } finally {
    f.inFlight = null;
  }
  void pump(key); // reassess: the read may have unblocked a pending submission
}

// Is this answer still about the puzzle that asked for it? A flight is MUTATED in place
// when its round re-registers, so a word republished while a request is in the air leaves
// that request describing the retired one. Everything a superseded answer would have
// written is dropped; the flight has already been reset to read again.
function superseded(f: WordFlight, puzzle: string): boolean {
  return f.puzzle !== puzzle;
}

async function readRound(f: WordFlight, key: string): Promise<void> {
  const puzzle = f.puzzle;
  let response: Response;
  try {
    response = await postRoundBody(roundUrl(f.lang, f.date, 'word'), {
      secret: playerSecret(),
      puzzle,
    });
  } catch {
    if (!superseded(f, puzzle)) retryLater(f);
    return;
  }
  if (superseded(f, puzzle)) return;
  if (response.ok) {
    let state: RoundState;
    try {
      state = parseRound(await response.json());
    } catch {
      retryLater(f);
      return;
    }
    // Re-checked after the body: reading it is another await, and a republish landing
    // inside it would leave this state describing the retired word.
    if (superseded(f, puzzle)) return;
    const startedAt = anchorFrom(state);
    if (startedAt !== null) useGameStore.getState().anchorWordRun(key, startedAt);
    adoptState(f, state);
    if (state.guesses.length > 0) {
      // The server demonstrably HOLDS a run for this round, so this device owes it
      // nothing — whether the log is its own or the one another device recorded first
      // (the submission is first-write-wins, so a second one would change nothing). Not
      // marking it here is not a correctness bug but a wasted POST on every device that
      // adopts a finished day, on every visit.
      useGameStore.getState().markWordSubmitted(key);
    }
  } else if (response.status === 404) {
    // The server holds nothing for THIS word: an unplayed day, or one republished under the
    // same key whose old record is retired. Nothing to resume; PLAY will create it.
  } else if (isVerdict(response.status)) {
    f.closed = true;
    return;
  } else {
    retryLater(f);
    return;
  }
  f.readDone = true;
  f.failures = 0;
}

async function submitRun(f: WordFlight, key: string, tried: readonly string[]): Promise<void> {
  const puzzle = f.puzzle;
  let response: Response;
  try {
    response = await postRoundBody(roundUrl(f.lang, f.date, 'word'), {
      secret: playerSecret(),
      puzzle,
      guesses: submittableLog(f.ranks, tried),
    });
  } catch {
    if (!superseded(f, puzzle)) retryLater(f);
    return;
  }
  if (superseded(f, puzzle)) return;

  let state: RoundState | null = null;
  let error: string | undefined;
  try {
    const data = (await response.json()) as { error?: unknown };
    error = typeof data.error === 'string' ? data.error : undefined;
    state = parseRound(data);
  } catch {
    state = null;
  }
  if (superseded(f, puzzle)) return;

  if (response.ok) {
    // 200 covers the SUBMISSION and the "already submitted" answer alike: the daily is
    // one-shot and cannot be replayed, so the FIRST write stands and this device owes the
    // server nothing further either way. The stored run is adopted — into an empty local
    // log only, since a word round's deadline is derived from its log and a finished run
    // must never re-open (gameStore's `adoptWordRun`).
    if (state) adoptState(f, state);
    useGameStore.getState().markWordSubmitted(key);
    f.closed = true;
    return;
  }
  // `too_early` is the one refusal worth waiting out: the wait check is the game's own
  // floor, so honest play cannot hit it, but a clock that disagrees by a second or two
  // can — and retrying a moment later succeeds. Every other 4xx is a VERDICT (no run was
  // ever started here; a body this client keeps getting wrong), and retrying it forever
  // would spin one request every 30 seconds for the tab's life.
  if (error !== 'too_early' && isVerdict(response.status)) {
    f.closed = true;
    return;
  }
  retryLater(f);
}

// Adopt what the server holds: the RECORDED run, which only ever lands in a log this
// device does not have one of (the store's own guard).
function adoptState(ctx: WordRoundContext, state: RoundState): void {
  if (state.guesses.length === 0) return;
  const run = replayWordRun(ctx.ranks, state.guesses);
  useGameStore.getState().adoptWordRun(ctx.roundKey, {
    tried: state.guesses,
    claimed: run.claimed.length,
    bonus: totalBonus(run.claimed, ctx.corpusSize),
  });
}

// A 4xx is a VERDICT — a request this client will keep getting wrong. (409 `too_early` is
// handled above: it is an answer about WHEN, not about the request.)
function isVerdict(status: number): boolean {
  return status >= 400 && status < 500;
}

function retryLater(f: WordFlight): void {
  f.failures += 1;
  f.lastFailureAt = Date.now();
}

// Test seam: drop every conversation (module state must not leak between tests).
export function resetWordRoundSync(): void {
  for (const f of flights.values()) if (f.timer !== null) clearTimeout(f.timer);
  flights.clear();
  starts.clear();
  startedHere.clear();
}
