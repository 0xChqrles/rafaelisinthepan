// The #201 sync engine: the server owns each round's guess log from the first guess,
// whether or not an account is ever linked. Local state stays the WORKING COPY — the
// judge of every guess (a submit must never round-trip before the board reacts) and the
// write buffer — and this engine keeps the server's copy converged behind it.
//
//   guess lands -> board reacts -> POST goes out -> response reconciles.
//
// Writes are COALESCED (sentence mode streams: fast typing accumulates while the
// ~ROUND_WRITE_MIN_MS pacing waits, then flushes as one batch) and every answer — a 200
// and BOTH refusals — carries the FULL stored log, which is adopted as truth. So an open
// tab reconciles on its own next write, and a second device's tries merge into the same
// board. Failed or slow writes queue and retry with a capped backoff: the game still
// works on a bad connection, because durability lives in the persisted `tried` log, not
// in the queue — a killed tab catches up on the next visit's read, which diffs the server
// log against localStorage and flushes the difference. That read is also what makes a
// player's full history follow them to a new device (#201), archive rounds included.
//
// At ROUND_GUESS_CAP the server refuses further appends (`round_full`): the round keeps
// playing locally but has stopped counting — the engine marks it capped and closes the
// conversation, and the solved screen suppresses its score submission accordingly.
//
// One conversation per round lives in a MODULE-level map (the activeScoreFlights
// pattern): a ref would not survive a real unmount, and neither the queue nor the
// in-flight write may be duplicated by a remount (archive round-trips, StrictMode).

import { ROUND_GUESS_CAP, ROUND_WRITE_MIN_MS, type RankMap, type RuntimeHole } from '@whippin/shared';
import { parseRound, postRoundBody, roundUrl } from '../api';
import { applyGuessToHoles, computeProgress, guessKey } from '../game/scoring';
import { useGameStore } from './gameStore';
import { playerSecret } from '../identity';

export interface RoundSyncContext {
  roundKey: string;
  lang: string;
  // Sentence mode only, deliberately. The route, the URL and the stored partition are all
  // mode-generic, but the STORE is not: a word round lives in its own `wordRounds` map
  // under a `w:` key, which `adoptRound`/`markRoundCapped` cannot reach and whose log a
  // hole replay does not describe. Widening this is #202's job, together with the store
  // actions — until then the type refuses the round rather than leaving a silent no-op
  // that would look like "my history doesn't follow me" instead of a compile error.
  mode: 'sentence';
  date: string;
  ranks: RankMap;
  freshHoles: RuntimeHole[];
}

interface RoundFlight extends RoundSyncContext {
  // Which PUZZLE this conversation is about (see `puzzleTag`).
  puzzle: string;
  // Prefix of the round's persisted `tried` known to be on the server. Everything from
  // here on is the pending batch; adoption resets it to the acked prefix length.
  pendingFrom: number;
  // How many entries the server's log RAW-ly holds — which is the number its cap counts,
  // and NOT `pendingFrom`. The two differ whenever the merge dedups the stored log
  // shorter (two devices each sending a guess that resolves to the other's identity,
  // #104), so sizing a batch against `pendingFrom` can overshoot the cap. Set from every
  // answer, since every answer carries the full stored log.
  serverCount: number;
  // The initial read has landed (or 404'd): local extras are safe to append from here on.
  readDone: boolean;
  // When the last APPEND SETTLED — see `writeDelayMs`.
  lastWriteSettledAt: number;
  failures: number;
  lastFailureAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
  closed: boolean;
}

const flights = new Map<string, RoundFlight>();

// Bound the map. Every flight pins its puzzle's whole rank map — megabytes of heap on a
// real sentence — and nothing used to remove one, so browsing a month of the archive kept
// a month of puzzles alive for the tab's life. Evicting is SAFE by construction, which is
// the design's own claim: durability lives in the persisted `tried` log, so a dropped
// conversation simply resumes on that round's next mount, with a read.
const MAX_FLIGHTS = 3;

// Ceiling on the retry window, so an outage cannot spin a request a second.
const MAX_BACKOFF_MS = 30_000;

// A puzzle SIGNATURE folded to the short opaque tag the server stores beside a round and
// only ever compares (backend roundStore.ts, `PUZZLE_TAG_SHAPE`). FNV-1a, base 36, so any
// signature — a sentence's holes, a word's slug — becomes a handful of characters the wire
// shape accepts. ONE encoding for both dailies: two spellings would be two ways for a tag
// to stop matching itself.
export function fnvTag(signature: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < signature.length; i += 1) {
    hash ^= signature.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

// Which PUZZLE a round's log belongs to. A round key is only (day, lang, mode), so
// RE-PUBLISHING a different sentence keeps the key while changing the puzzle — the store
// resets the local round on exactly that (`holesMatchPuzzle`), and without this tag the
// mount read would hand the RETIRED sentence's log straight back and undo the reset for
// good. The signature is what `holesMatchPuzzle` itself compares.
export function puzzleTag(holes: RuntimeHole[]): string {
  return fnvTag(holes.map((h) => `${h.pos}:${h.secret}`).join('|'));
}

// How long the next APPEND must wait for the per-player write interval — measured from
// when the previous write SETTLED, not from when it was sent.
//
// That difference is the whole point. The server's condition compares its OWN receipt
// instants (`lastWriteAt < now - ROUND_WRITE_MIN_MS`, strictly), so pacing one interval
// from our SEND time leaves the accepted gap at `interval + (latency_n - latency_{n-1})`:
// any request that travels faster than its predecessor is refused, which on a jittery
// link is about half of them. Waiting an interval from the ANSWER instead puts the
// server's own round trip inside the gap, so it can only ever exceed the interval.
export function writeDelayMs(lastWriteSettledAt: number, now: number): number {
  if (lastWriteSettledAt === 0) return 0; // nothing written yet — flush immediately
  return Math.max(0, lastWriteSettledAt + ROUND_WRITE_MIN_MS - now);
}

// How long a failed attempt waits before the next one: the interval doubled per
// consecutive failure, up to the ceiling. Pure, and injected `now`, so the schedule is
// asserted without sleeping.
export function backoffDelayMs(failures: number, lastFailureAt: number, now: number): number {
  if (failures === 0) return 0;
  const windowMs = Math.min(ROUND_WRITE_MIN_MS * 2 ** failures, MAX_BACKOFF_MS);
  return Math.max(0, lastFailureAt + windowMs - now);
}

// Merge the server's log with the local one: server entries first (they are the acked
// truth), then local-only tries in their own order, deduped throughout by canonical
// identity (#104's guessKey) — the same dedup recordGuess applies, so the merged log
// replays to exactly one board. Returns how many of the merged entries came from the
// SERVER: that prefix needs no further writing, and everything after it is the pending
// batch.
export function mergeLogs(
  server: string[],
  local: string[],
  keyOf: (typed: string) => string,
): { guesses: string[]; acked: number } {
  const seen = new Set<string>();
  const guesses: string[] = [];
  const push = (typed: string) => {
    const id = keyOf(typed);
    if (seen.has(id)) return;
    seen.add(id);
    guesses.push(typed);
  };
  for (const g of server) push(g);
  const acked = guesses.length;
  for (const g of local) push(g);
  return { guesses, acked };
}

// Replay a whole log onto fresh holes — the board as the server's truth sees it.
export function replayHoles(
  freshHoles: RuntimeHole[],
  ranks: RankMap,
  tried: string[],
): RuntimeHole[] {
  const holes = freshHoles.map((h) => ({ ...h }));
  for (const typed of tried) applyGuessToHoles(holes, ranks, typed);
  return holes;
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
  // Map iterates in insertion order and `beginRoundSync` re-inserts on every refresh, so
  // this drops the least recently registered idle conversations first.
  for (const [key, f] of flights) {
    if (flights.size <= MAX_FLIGHTS) return;
    if (key === keep || f.inFlight) continue;
    if (f.timer !== null) clearTimeout(f.timer);
    flights.delete(key);
  }
}

// Register a round's sync context (Game mounts one per round) and start its
// conversation: the first registration reads the server's copy and adopts whatever the
// local device is missing; later registrations only refresh the context.
export function beginRoundSync(ctx: RoundSyncContext): void {
  const puzzle = puzzleTag(ctx.freshHoles);
  const existing = flights.get(ctx.roundKey);
  if (existing) {
    // A sentence re-published UNDER an open conversation: the acked prefix describes the
    // retired log, so the conversation starts over (and re-opens if the old one had hit
    // the cap — a fresh round is not a capped one).
    if (existing.puzzle !== puzzle) {
      existing.pendingFrom = 0;
      existing.serverCount = 0;
      existing.readDone = false;
      existing.closed = false;
      existing.failures = 0;
    }
    Object.assign(existing, ctx, { puzzle });
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
    pendingFrom: 0,
    serverCount: 0,
    readDone: false,
    lastWriteSettledAt: 0,
    failures: 0,
    lastFailureAt: 0,
    timer: null,
    inFlight: null,
    closed: false,
  });
  pruneFlights(ctx.roundKey);
  void pump(ctx.roundKey);
}

// A counted guess just entered the local log: something may now be pending.
export function notifyGuess(roundKey: string): void {
  if (!flights.has(roundKey)) return;
  void pump(roundKey);
}

async function pump(key: string): Promise<void> {
  const f = flights.get(key);
  if (!f || f.closed || f.inFlight) return;

  const round = useGameStore.getState().rounds[key];
  if (!round) return;
  // The cap already stopped this round counting, and that flag is PERSISTED. Reading it
  // here is what keeps a reload from re-opening the conversation for a read, a
  // guaranteed-409 append and another `round_full` line — reload noise in a signal whose
  // whole value is that each entry means a real player hit the cap.
  if (round.capped) {
    f.closed = true;
    return;
  }
  // The local round was reset under this key (a republish, an eviction): the acked prefix
  // no longer describes this log, so start the conversation over.
  if (round.tried.length < f.pendingFrom) {
    f.pendingFrom = 0;
    f.serverCount = 0;
    f.readDone = false;
  }

  const now = Date.now();
  const delay = Math.max(
    backoffDelayMs(f.failures, f.lastFailureAt, now),
    // Only an APPEND waits on the write interval: the server's rate condition lives in
    // the append's own condition, so a read is never refused for being too soon.
    f.readDone ? writeDelayMs(f.lastWriteSettledAt, now) : 0,
  );
  if (delay > 0) {
    schedule(key, delay);
    return;
  }

  if (!f.readDone) {
    f.inFlight = readRound(f, key);
  } else {
    if (round.tried.length <= f.pendingFrom) return; // nothing pending
    // Never send a batch the route can only refuse. The stored log may hold at most
    // ROUND_GUESS_CAP entries, so the batch is clamped to what still fits — and when a
    // pending try cannot fit AT ALL, the round has stopped counting and says so locally
    // rather than spending a doomed request. (An unclamped batch takes a 400, which is
    // not the 409 this engine handles: it would re-send the identical body every 30s
    // forever and the round would never be marked capped at all.)
    //
    // Order matters: the cap is reached only when there is a guess the server WILL
    // refuse, exactly as its own 409 means. A round whose acked log sits at exactly the
    // cap with nothing pending is finished, not capped — marking it here would suppress
    // the leaderboard entry of someone who solved on their 500th try.
    const room = ROUND_GUESS_CAP - f.serverCount;
    if (room <= 0) {
      useGameStore.getState().markRoundCapped(key);
      f.closed = true;
      return;
    }
    f.inFlight = appendBatch(f, key, round.tried.slice(f.pendingFrom, f.pendingFrom + room));
  }
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
  void pump(key); // reassess: retries, coalesced arrivals, adoption leftovers
}

function requestBody(f: RoundFlight, guesses?: string[]) {
  return { secret: playerSecret(), puzzle: f.puzzle, guesses };
}

// Is this answer still about the puzzle that asked for it? A flight is MUTATED in place
// when its round re-registers, so a sentence re-published while a request is in the air
// leaves that request describing the retired puzzle while `f` already carries the
// corrected one's ranks and holes. Applying it would replay the old log onto the new
// board — the very thing the tag exists to prevent, arriving through the back door.
// Everything a superseded answer would have written is dropped; the flight has already
// been reset to read again, and `pump` restarts it.
function superseded(f: RoundFlight, puzzle: string): boolean {
  return f.puzzle !== puzzle;
}

async function readRound(f: RoundFlight, key: string): Promise<void> {
  const puzzle = f.puzzle;
  let response: Response;
  try {
    response = await postRoundBody(roundUrl(f.lang, f.date, f.mode), requestBody(f));
  } catch {
    if (!superseded(f, puzzle)) retryLater(f);
    return;
  }
  if (superseded(f, puzzle)) return;
  if (response.ok) {
    let guesses: string[];
    try {
      guesses = parseRound(await response.json()).guesses;
    } catch {
      retryLater(f);
      return;
    }
    // Re-checked after the body: reading it is another await, and a republish landing
    // inside it would leave this log describing the retired sentence.
    if (superseded(f, puzzle)) return;
    adopt(f, key, guesses);
  } else if (response.status === 404) {
    // The server holds nothing for THIS puzzle: a fresh round, or a daily re-published
    // under the same key whose old record is retired. Nothing is acked, and the first
    // append creates (or replaces) the record.
    f.pendingFrom = 0;
    f.serverCount = 0;
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

async function appendBatch(f: RoundFlight, key: string, batch: string[]): Promise<void> {
  const puzzle = f.puzzle;
  let response: Response;
  try {
    response = await postRoundBody(roundUrl(f.lang, f.date, f.mode), requestBody(f, batch));
  } catch {
    // The write never reached an answer — and it may still have COMMITTED (a suspended
    // tab, a dropped connection, a gateway timeout). Re-sending the same batch would
    // `list_append` it a second time and burn the cap on a duplicate the client's own
    // dedup then hides, so the recovery is a RE-READ: only the server can say what it
    // holds, and the watermark comes from that rather than from a guess.
    if (!superseded(f, puzzle)) resync(f);
    return;
  }

  // Stamp the interval from the ANSWER, whatever it says (see `writeDelayMs`) — and even
  // when the answer is superseded, because the write still LANDED on the same stored
  // item, so the server's next accepted write is an interval past this one either way.
  f.lastWriteSettledAt = Date.now();

  if (response.ok || response.status === 409 || response.status === 429) {
    // All three carry the full stored log (the route's own contract), so all three
    // reconcile the same way — which is what makes a refusal useful rather than merely
    // survivable.
    let guesses: string[];
    try {
      guesses = parseRound(await response.json()).guesses;
    } catch {
      if (!superseded(f, puzzle)) resync(f);
      return;
    }
    // A superseded answer describes the RETIRED puzzle: not its log, not its cap, not
    // its failure count. The republish already reset this flight to read again.
    if (superseded(f, puzzle)) return;
    adopt(f, key, guesses);
    f.failures = 0;
    if (response.status === 409 && f.serverCount >= ROUND_GUESS_CAP) {
      // The cap: the round stops counting (#201). Mark the round so the score is never
      // submitted, close the conversation, and let local play continue untouched.
      //
      // Gated on the log the refusal CARRIED, not on the refusal itself. A 409 also
      // answers a batch sized against a STALE watermark — another device pushed the
      // stored log forward while this tab was away, so a correctly-clamped-when-sent
      // batch no longer fits — and there the round has room left and simply needs a
      // smaller batch. Concluding "capped" from the status alone would suppress the
      // leaderboard entry of a round that was never full, which is the harshest
      // consequence this design has. The truth the answer carried decides; `pump` sizes
      // the next batch from it and marks the round capped only when nothing fits at all.
      useGameStore.getState().markRoundCapped(key);
      f.closed = true;
    }
    // A 429 needs nothing more: the write window now holds the next attempt one full
    // interval past this answer, which is exactly what the server measures against.
    return;
  }

  if (superseded(f, puzzle)) return;
  if (isVerdict(response.status)) {
    f.closed = true;
    return;
  }
  resync(f);
}

// A 4xx is a VERDICT — a request this client will keep getting wrong (a language the
// server does not serve, a date outside its window, a body the route refuses). Retrying
// it forever spins one request every 30s for the tab's life, and on the READ it also
// stalls every append behind it, so the guesses reach the server on no visit ever. The
// conversation closes instead; the log stays in localStorage and the next visit asks once
// more. (409 and 429 are handled above — they are answers, not verdicts.)
function isVerdict(status: number): boolean {
  return status >= 400 && status < 500;
}

function retryLater(f: RoundFlight): void {
  f.failures += 1;
  f.lastFailureAt = Date.now();
}

// The write's outcome is unknown: fall back to the read, which is the only thing that can
// say what the server actually holds, and count the failure so the backoff widens.
function resync(f: RoundFlight): void {
  f.readDone = false;
  retryLater(f);
}

// Adopt the server's log as this round's truth: merge it under the local log, replay the
// merged board, and hand it to the store in one write. The acked prefix becomes the new
// pending watermark.
function adopt(f: RoundFlight, key: string, serverGuesses: string[]): void {
  const round = useGameStore.getState().rounds[key];
  if (!round) return;
  const { guesses, acked } = mergeLogs(serverGuesses, round.tried, (t) => guessKey(f.ranks, t));
  // Exactly `acked` entries of the MERGED log are server-held, and that log is what the
  // round now holds — so the watermark IS that number, never a running maximum. A max
  // strands local tries whenever the merge dedups the server's own log shorter.
  f.pendingFrom = acked;
  f.serverCount = serverGuesses.length;
  // The overwhelmingly common answer is the server echoing back what we just sent.
  // Writing the round again for that would re-serialize the whole persist blob AND,
  // because the holes go with it, apply every pending hole improvement on the spot — out
  // from under Game.submit's deliberate deferral of each swap to its floating hit's
  // fade-out, which on a fast connection is every guess.
  if (sameLog(guesses, round.tried)) return;
  const holes = replayHoles(f.freshHoles, f.ranks, guesses);
  // The cached progress goes with the board it describes: `syncProgress` can only ever
  // repair the ACTIVE round, and an adoption routinely lands after the player has
  // navigated away, which would leave that day's archive cell painting a stale fill for
  // good.
  useGameStore.getState().adoptRound(key, guesses, holes, computeProgress(holes, f.ranks));
}

function sameLog(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((entry, i) => entry === b[i]);
}

// Test seam: drop every conversation (module state must not leak between tests).
export function resetRoundSync(): void {
  for (const f of flights.values()) if (f.timer !== null) clearTimeout(f.timer);
  flights.clear();
}
