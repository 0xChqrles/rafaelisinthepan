// The sentence round's conversation with the server (#201, reworked by #214).
//
// The server owns each round's guess log from the first guess, whether or not an account is
// ever linked — and since #214 the client stops keeping a copy of what it owns. There are
// three deliberately different values (see `game/playLog.ts`): the SERVER STATE, held here
// in memory and mirrored into the store for the screen; the OUTBOX, the only persisted
// sentence-round state, holding exactly the guesses the server has not acknowledged; and
// the PLAY LOG, a pure projection of the two that the screen derives everything from.
//
// The game is therefore deliberately NETWORK-DEPENDENT at load: the round is read before
// the board becomes interactive, and a failed read is a visible state rather than
// permission to start from a guessed local mirror. Once both reads have settled, play is
// instant again — a guess is judged locally, the board reacts, the POST goes out behind it.
//
//   guess lands -> board reacts -> outbox grows -> POST goes out -> answer replaces truth.
//
// Writes are COALESCED (the client streams: fast typing accumulates while the
// ~ROUND_WRITE_MIN_MS pacing waits, then flushes as one batch) and every answer — a 200 and
// BOTH refusals — carries the FULL stored state, which REPLACES the server snapshot. So an
// open tab reconciles on its own next write, and a second device's tries merge into the same
// board through the projection rather than through a merge.
//
// The old reconciliation problem is gone because nothing acknowledged is persisted: there is
// no watermark to keep honest, no `pendingFrom`, and no authority-bearing merge. What is left
// is an outbox that shrinks by identity as the server's log grows.
//
// At ROUND_GUESS_CAP the server refuses further appends (`round_full`). A round is CAPPED
// when the authoritative state is UNSOLVED with exactly that many raw entries — a fact the
// screen derives, never a flag anyone stores — and there the round ends at `∞` (#214).
//
// A GIVE-UP (`giveUpRound`) is the conversation's one other write: the player ends the round
// unsolved. It goes out only once the outbox is FLUSHED — the log stays the player's real
// tries — and the server stores it as a flag that freezes the round like a solve.
//
// One conversation per round lives in a MODULE-level map (the activeScoreFlights pattern):
// a ref would not survive a real unmount, and neither the queue nor the in-flight write may
// be duplicated by a remount (archive round-trips, StrictMode).

import { PREVIEW_REFUSED, ROUND_GUESS_CAP, ROUND_WRITE_MIN_MS, roundEnded, type RankMap } from '@whippin/shared';
import { parseRound, postRoundBody, roundUrl, type RoundState } from '../api';
import { guessKey } from '../game/scoring';
import { unacknowledged } from '../game/playLog';
import { EMPTY_ROUND_SERVER, useGameStore, type RoundLoad, type RoundServer } from './gameStore';
import {
  currentRequestIdentity,
  deviceIdentity,
  identityEpoch,
  identityEpochOf,
} from '../identity';
import { adoptSignedOutVerdict } from './signedOutVerdict';
import { turnstileToken } from '../turnstile';

export interface RoundSyncContext {
  roundKey: string;
  lang: string;
  // The puzzle's ADDRESS (shared bonus.ts): the game day, or a BONUS puzzle's `bonus/<id>`,
  // which the round URL sends as `bonus=<id>`.
  date: string;
  // The operator's PREVIEW CODE for a day not yet out (shared preview.ts), sent on every
  // `/round` call of this round. The key is always present on a registration (`undefined`
  // when there is none), so re-registering a round without one clears a stale code.
  previewCode?: string;
  // WHICH PUBLISHED VERSION of this daily is being played — the round's identity everywhere
  // (#203). The hole layout used to play that part and could not tell a corrected puzzle
  // from the one it replaced when the sentence was unchanged.
  revision: string;
  // Only for the canonical identity (#104's `guessKey`): what "the server already holds
  // this guess" means when two devices typed two surfaces of one group.
  ranks: RankMap;
}

interface RoundFlight extends RoundSyncContext {
  // The last state the server told us about. The RAW log — its length is what the cap
  // counts, and it is NOT the play log's length whenever the projection dedups two devices'
  // surfaces of one group.
  server: RoundServer;
  // The current read has landed (or 404'd). Cleared by `resync`, which is what makes an
  // unknown write outcome fall back to a read.
  readDone: boolean;
  // This round has settled AT LEAST ONCE, so the screen is interactive. It is a separate
  // fact from `readDone` precisely because `resync` clears that one: a recovery read that
  // fails is a sync hiccup behind a live board, and pulling the player back to a load
  // error there would take a played round away from them mid-guess.
  settled: boolean;
  // Does the server already hold a record for THIS puzzle? Round CREATION is Turnstile-
  // gated since #203 (the challenge moved off the retired score POST to where state is
  // actually minted), so the first append carries a token and every later one does not.
  // Set from the read (a 200 means a record exists, a 404 that none does) and from the
  // first accepted append.
  created: boolean;
  // When the last APPEND SETTLED — see `writeDelayMs`.
  lastWriteSettledAt: number;
  failures: number;
  lastFailureAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
  closed: boolean;
  // A GIVE-UP the screen asked for (`giveUpRound`), answered exactly once: true once the
  // round is over on the server's terms, false when it did not land. `sent`: the request
  // went out and its outcome is UNKNOWN (transport, 5xx, malformed), so the re-read that
  // follows is what answers it — never a blind re-send.
  giveUp: { promise: Promise<boolean>; resolve: (ended: boolean) => void; sent: boolean } | null;
}

const flights = new Map<string, RoundFlight>();

// Bound the map. Every flight pins its puzzle's whole rank map — megabytes of heap on a
// real sentence — and nothing used to remove one, so browsing a month of the archive kept
// a month of puzzles alive for the tab's life. Evicting is SAFE by construction: the
// server owns the log, so a dropped conversation simply resumes on that round's next
// mount, with a read.
const MAX_FLIGHTS = 3;

// Ceiling on the retry window, so an outage cannot spin a request a second.
const MAX_BACKOFF_MS = 30_000;

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
  // this drops the least recently registered idle conversations first. The evicted round's
  // published state goes with it: the flight is what owns it, and the next mount reads.
  for (const [key, f] of flights) {
    if (flights.size <= MAX_FLIGHTS) return;
    if (key === keep || f.inFlight || f.giveUp) continue;
    if (f.timer !== null) clearTimeout(f.timer);
    flights.delete(key);
    useGameStore.getState().setRoundLoad(key, null);
  }
}

// Register a round's sync context (Game mounts one per round) and start its conversation:
// the first registration reads the server's copy, which is what the screen waits on; later
// registrations only refresh the context.
export function beginRoundSync(ctx: RoundSyncContext): void {
  const puzzle = ctx.revision;
  const existing = flights.get(ctx.roundKey);
  if (existing) {
    // A sentence re-published UNDER an open conversation: everything the flight knows
    // describes the retired puzzle, so the conversation starts over — and re-opens if the
    // old one had closed at the cap or the freeze, since a fresh round is neither.
    if (existing.revision !== puzzle) {
      // A give-up asked of the retired puzzle is not one of the corrected puzzle's.
      answerGiveUp(existing, false);
      existing.server = EMPTY_ROUND_SERVER;
      existing.readDone = false;
      existing.settled = false;
      existing.created = false;
      existing.closed = false;
      existing.failures = 0;
      useGameStore.getState().setRoundLoad(ctx.roundKey, { status: 'loading', puzzle });
    }
    Object.assign(existing, ctx);
    // Re-insert so the LRU sees this round as the most recent.
    flights.delete(ctx.roundKey);
    flights.set(ctx.roundKey, existing);
    pruneFlights(ctx.roundKey);
    void pump(ctx.roundKey);
    return;
  }
  flights.set(ctx.roundKey, {
    ...ctx,
    server: EMPTY_ROUND_SERVER,
    readDone: false,
    settled: false,
    created: false,
    lastWriteSettledAt: 0,
    failures: 0,
    lastFailureAt: 0,
    timer: null,
    inFlight: null,
    closed: false,
    giveUp: null,
  });
  useGameStore.getState().setRoundLoad(ctx.roundKey, { status: 'loading', puzzle });
  pruneFlights(ctx.roundKey);
  void pump(ctx.roundKey);
}

// A counted guess just entered the outbox: something is now pending.
export function notifyGuess(roundKey: string): void {
  if (!flights.has(roundKey)) return;
  void pump(roundKey);
}

// THE GIVE-UP (the screen's confirm): end this round unsolved. Resolves TRUE once the round
// is over on the server's terms — given up, or a solve that won the race — and FALSE when
// the give-up did not land (a refusal, a flush whose outcome is unknown, or a give-up the
// re-read could not confirm); the round then stays open and the player may ask again. What the outbox still owes is FLUSHED
// first, so the log the give-up freezes holds every try the player made.
export function giveUpRound(roundKey: string): Promise<boolean> {
  const f = flights.get(roundKey);
  if (!f || deviceIdentity() === null) return Promise.resolve(false);
  if (f.closed) return Promise.resolve(over(f));
  if (f.giveUp) return f.giveUp.promise;
  let resolve!: (ended: boolean) => void;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  f.giveUp = { promise, resolve, sent: false };
  // Asked for NOW: a backoff left by an earlier hiccup must not hold the player's answer.
  f.failures = 0;
  f.lastFailureAt = 0;
  void pump(roundKey);
  return promise;
}

// Is this round over on the server's terms — solved, or ended unsolved (given up, or capped:
// the shared `roundEnded`)?
function over(f: RoundFlight): boolean {
  return f.server.solved || roundEnded(f.server);
}

// Answer a pending give-up, once.
function answerGiveUp(f: RoundFlight, ended: boolean): void {
  const pendingGiveUp = f.giveUp;
  if (!pendingGiveUp) return;
  f.giveUp = null;
  pendingGiveUp.resolve(ended);
}

// The conversation is over: nothing more is sent. A give-up waiting on it is answered by
// how it ended — over on the server's terms is what it asked for.
function close(f: RoundFlight): void {
  f.closed = true;
  answerGiveUp(f, over(f));
}

// The screen's RETRY on a failed load: spend the backoff now rather than waiting it out,
// and re-open a conversation a verdict closed — the player asked, and a verdict this
// client keeps getting wrong will simply be answered again.
export function retryRoundSync(roundKey: string): void {
  const f = flights.get(roundKey);
  if (!f) return;
  f.failures = 0;
  f.lastFailureAt = 0;
  if (!f.settled) {
    f.closed = false;
    useGameStore.getState().setRoundLoad(roundKey, { status: 'loading', puzzle: f.revision });
  }
  void pump(roundKey);
}

// What this round still owes the server: the outbox, but only while it names THIS puzzle.
// A mismatch means `ensureOutbox` has not reconciled yet (or an eviction removed it), and
// sending a retired round's guesses is the one thing the revision exists to prevent.
function pending(f: RoundFlight): string[] {
  const outbox = useGameStore.getState().outbox[f.roundKey];
  return outbox && outbox.puzzle === f.revision ? outbox.guesses : [];
}

async function pump(key: string): Promise<void> {
  const f = flights.get(key);
  if (!f || f.closed || f.inFlight) return;

  const now = Date.now();
  const delay = Math.max(
    backoffDelayMs(f.failures, f.lastFailureAt, now),
    // Only an APPEND waits on the write interval: the server's rate condition lives in
    // the append's own condition, so neither a read nor a give-up is refused for being
    // too soon.
    f.readDone && pending(f).length > 0 ? writeDelayMs(f.lastWriteSettledAt, now) : 0,
  );
  if (delay > 0) {
    schedule(key, delay);
    return;
  }

  if (!f.readDone) {
    // **No token means no private fetch** (#216). A device with no identity holds no server
    // rows by construction, so the round's authoritative state is KNOWN empty — asking would
    // be a request whose only possible answer we already have, and it would bootstrap an
    // account for a visit that has not acted. The PLAY gate's deploy creates both (the
    // trigger rework: the append below never mints).
    if (deviceIdentity() === null) {
      f.created = false;
      f.readDone = true;
      publish(f, EMPTY_ROUND_SERVER);
      // Reassess straight away, for the race where an identity arrived while this branch
      // ran. A persisted outbox with no identity simply keeps waiting: since the trigger
      // rework the append never mints, and the gate's deploy is what kicks it loose.
      void pump(key);
      return;
    }
    f.inFlight = readRound(f);
  } else {
    const owed = pending(f);
    if (owed.length === 0) {
      // Nothing owed: the give-up, if one is asked for — never before the flush, or the
      // freeze it stores would refuse the last tries and drop them. One already sent is
      // waiting on the re-read, not on another send.
      if (!f.giveUp || f.giveUp.sent) return;
      f.inFlight = sendGiveUp(f);
    } else {
      // NO IDENTITY, NO WRITE (#216 trigger rework): guesses cannot be typed behind the
      // PLAY gate, so an owed outbox with no identity is the pending-bootstrap recovery
      // case. It waits here — the append never mints — and the identity listener pumps
      // every conversation when the gate's deploy lands (`kickRoundSync`).
      if (deviceIdentity() === null) return;
      // Never send a batch the route can only refuse. The stored log may hold at most
      // ROUND_GUESS_CAP entries, so the batch is the OLDEST PREFIX that still fits — and
      // when nothing fits at all, this round is capped: it has stopped counting, and saying
      // so locally beats spending a doomed request. (An unclamped batch takes a 400, which
      // is not the 409 this engine handles: it would re-send the identical body every 30s
      // forever.)
      //
      // Room is measured against the RAW stored count, never the play log's: the two
      // differ whenever the projection dedups two devices' surfaces of one group, and the
      // cap counts what is STORED.
      const room = ROUND_GUESS_CAP - f.server.guesses.length;
      if (room <= 0) {
        // The terminal state is DERIVED from the state already published (unsolved, at
        // the cap), so there is nothing to mark — only guesses that can never be stored to
        // drop.
        discardOutbox(f);
        close(f);
        return;
      }
      f.inFlight = appendBatch(f, owed.slice(0, room));
    }
  }
  try {
    await f.inFlight;
  } catch {
    // Neither leg is expected to throw — both own their own error paths — but an
    // unexpected one must not escape as an unhandled rejection, and above all must not
    // leave `inFlight` pinned: that wedges this conversation shut for the tab's life.
    answerGiveUp(f, false);
    retryLater(f);
  } finally {
    f.inFlight = null;
  }
  void pump(key); // reassess: retries, coalesced arrivals, leftovers
}

function requestBody(f: RoundFlight, token: string, guesses?: string[], challenge?: string) {
  return { token, puzzle: f.revision, guesses, turnstileToken: challenge };
}

// Is this answer still about the puzzle — and the IDENTITY — that asked for it? A flight is
// MUTATED in place when its round re-registers, so a sentence re-published while a request
// is in the air leaves that request describing the retired puzzle while `f` already carries
// the corrected one's revision and ranks. The identity half is #216's: `epoch` is captured
// when the request goes OUT and compared with the one in force when the answer lands, so an
// answer that outlives a sign-out or a fresh start belongs to an account this device no
// longer acts as — and adopting it would walk that account's board into the new one.
// Everything a superseded answer would have written is dropped; the flight has already been
// reset to read again, and `pump` restarts it.
function superseded(f: RoundFlight, puzzle: string, epoch: string | null): boolean {
  return f.revision !== puzzle || epoch !== identityEpoch();
}

// Take the server's answer as this round's truth and publish it to the screen. `byAppend`
// says whether a SOLVE in it was confirmed by a batch this device just sent: that one is a
// fresh solve and earns the round's beats, where a solve read at mount or refused as
// `round_solved` is adopted history — shown, never celebrated.
function adopt(f: RoundFlight, state: RoundState, byAppend: boolean): void {
  publish(f, {
    guesses: state.guesses,
    solved: state.solved,
    gaveUp: state.gaveUp,
    // Only ever true, like the flag itself: a later answer about an already-known solve
    // must not downgrade the beats this device already earned.
    solvedByAppend: (f.server.solved && f.server.solvedByAppend) || (state.solved && byAppend),
    // Same shape: only the CONFIRMING append's answer carries it, and later answers about
    // the same solve must not take it back.
    credited: (f.server.solved && f.server.credited) || (state.solved && state.credited),
  });
}

function publish(f: RoundFlight, server: RoundServer): void {
  const settled = f.settled;
  f.server = server;
  f.settled = true;
  // The overwhelmingly common answer is the server echoing back what we just sent, and the
  // state it describes is then identical to the one already on screen. Writing it anyway
  // would hand the round a new object about once a second while a player types, and every
  // derivation downstream — the play log, the board replay, the run's trajectory — would
  // recompute for a value that did not change.
  if (settled && sameServer(useGameStore.getState().roundLoads[f.roundKey], f.revision, server)) return;
  useGameStore.getState().setRoundLoad(f.roundKey, { status: 'ready', puzzle: f.revision, server });
}

function sameServer(load: RoundLoad | undefined, puzzle: string, next: RoundServer): boolean {
  if (load?.status !== 'ready' || load.puzzle !== puzzle) return false;
  const { server } = load;
  return (
    server.solved === next.solved &&
    server.gaveUp === next.gaveUp &&
    server.solvedByAppend === next.solvedByAppend &&
    server.credited === next.credited &&
    server.guesses.length === next.guesses.length &&
    server.guesses.every((entry, i) => entry === next.guesses[i])
  );
}

// Drop from the outbox everything the server's log now represents — by canonical identity,
// since the stored log is RAW and two devices can each have sent a different surface of one
// group (#104). After an accepted write this covers the batch that was just sent (the
// server demonstrably holds it) AND anything else that arrived meanwhile, which is why
// there is no sent-prefix bookkeeping to keep honest.
function settleOutbox(f: RoundFlight): void {
  const store = useGameStore.getState();
  const outbox = store.outbox[f.roundKey];
  if (!outbox || outbox.puzzle !== f.revision) return;
  const remaining = unacknowledged(outbox.guesses, f.server.guesses, (t) => guessKey(f.ranks, t));
  if (remaining.length === outbox.guesses.length) return;
  store.setOutbox(f.roundKey, f.revision, remaining);
}

// The round is over on the server's terms (solved, given up, or capped): what this device still had
// pending was REFUSED and will never be stored, so it is dropped for good rather than left
// to count tries the recorded score does not.
function discardOutbox(f: RoundFlight): void {
  useGameStore.getState().discardOutbox(f.roundKey, f.revision);
}

async function readRound(f: RoundFlight): Promise<void> {
  const puzzle = f.revision;
  const identity = deviceIdentity();
  // `pump` has already taken the tokenless branch, so this can only be a race with a
  // sign-out; treat it as the superseded answer it would become.
  if (!identity) return;
  const epoch = identityEpochOf(identity);
  let response: Response;
  try {
    response = await postRoundBody(
      roundUrl(f.lang, f.date, f.previewCode),
      requestBody(f, identity.token),
    );
  } catch {
    if (!superseded(f, puzzle, epoch)) failRead(f);
    return;
  }
  if (superseded(f, puzzle, epoch)) return;
  if (response.ok) {
    let state: RoundState;
    try {
      state = parseRound(await response.json());
    } catch {
      if (!superseded(f, puzzle, epoch)) failRead(f);
      return;
    }
    // Re-checked after the body: reading it is another await, and a republish landing
    // inside it would leave this log describing the retired sentence.
    if (superseded(f, puzzle, epoch)) return;
    // The server HAS a record for this puzzle, so no further append mints one and none
    // carries a challenge.
    f.created = true;
    adopt(f, state, false);
    // A solved or GIVEN-UP round is FROZEN — it accepts no further appends — so anything
    // still pending was refused before it could be stored. Every other read merely
    // acknowledges.
    if (state.solved || state.gaveUp) {
      discardOutbox(f);
      f.readDone = true;
      close(f);
      return;
    }
    // This is also the recovery from an UNKNOWN write outcome: a write that committed but
    // lost its answer is invisible anywhere except in the log the server hands back, and
    // re-sending it blindly would `list_append` a whole batch twice — burning cap slots on
    // duplicates the projection then hides, and manufacturing a false "unreachable puzzle"
    // signal near the cap.
    settleOutbox(f);
    // A give-up whose outcome was unknown did NOT land: the round stays open, and the
    // player is told so rather than having it sent again behind their back.
    if (f.giveUp?.sent) answerGiveUp(f, false);
  } else if (response.status === 404 && (await isPreviewRefused(response))) {
    // A REFUSED PREVIEW CODE (shared `PREVIEW_REFUSED`) is no empty round: the server will
    // store nothing under it — a puzzle the edge still serves from a code since voided, say —
    // so a board opened on it would take guesses that are never kept. A failed load, said on
    // screen; this conversation has nothing left to ask.
    if (superseded(f, puzzle, epoch)) return;
    failLoad(f);
    close(f);
    return;
  } else if (response.status === 404) {
    // The server holds nothing for THIS puzzle: a fresh round, or a daily re-published
    // under the same key whose old record is retired. Nothing is acknowledged — the whole
    // outbox is still owed — and the first append creates (or replaces) the record,
    // carrying the round-start challenge.
    f.created = false;
    publish(f, EMPTY_ROUND_SERVER);
    if (f.giveUp?.sent) answerGiveUp(f, false);
  } else if (isVerdict(response.status)) {
    // A device signed out from elsewhere learns it HERE first, since the mount read is the
    // earliest private call a game route makes. The screen it raises is the whole answer;
    // this conversation has nothing left to ask. (`adoptSignedOutVerdict` is the ONE
    // spelling of that resolution — the CODE decides, never the status.)
    await adoptSignedOutVerdict(response, epoch);
    if (superseded(f, puzzle, epoch)) return;
    failLoad(f);
    close(f);
    return;
  } else {
    failRead(f);
    return;
  }
  f.readDone = true;
  f.failures = 0;
}

// Whether a 404 is a refused DAY PREVIEW code rather than "no round recorded" — the CODE
// decides, never the status. An unreadable body is the plain 404 it always was.
async function isPreviewRefused(response: Response): Promise<boolean> {
  try {
    const data = (await response.json()) as { error?: unknown };
    return data.error === PREVIEW_REFUSED;
  } catch {
    return false;
  }
}

// A read that reached no answer: retried behind the backoff, and a give-up waiting on it is
// answered NOW — it did not land as far as anyone can tell, and the player must not sit on a
// busy button through an outage. Should it have landed after all, the retried read adopts it
// and the round closes on its own.
function failRead(f: RoundFlight): void {
  answerGiveUp(f, false);
  retryLater(f);
}

// THE GIVE-UP's own request (`giveUpRound`): `{token, puzzle, giveUp: true}`, sent once the
// outbox is flushed. A 2xx is the round given up; a `round_solved` refusal is a solve that
// won the race — over all the same, on the better terms; any other 4xx did not land (the
// round stays open); an UNKNOWN outcome re-reads, and the read answers it.
async function sendGiveUp(f: RoundFlight): Promise<void> {
  const puzzle = f.revision;
  const request = currentRequestIdentity();
  if (!request) {
    answerGiveUp(f, false);
    return;
  }
  const { identity, epoch } = request;
  f.giveUp!.sent = true;
  let response: Response;
  try {
    response = await postRoundBody(roundUrl(f.lang, f.date, f.previewCode), {
      token: identity.token,
      puzzle,
      giveUp: true,
    });
  } catch {
    if (!superseded(f, puzzle, epoch)) resync(f);
    return;
  }
  if (superseded(f, puzzle, epoch)) return;
  if (response.ok || response.status === 409) {
    let state: RoundState;
    try {
      state = parseRound(await response.json());
    } catch {
      if (!superseded(f, puzzle, epoch)) resync(f);
      return;
    }
    if (superseded(f, puzzle, epoch)) return;
    f.failures = 0;
    adopt(f, state, false);
    if (state.solved || state.gaveUp) {
      discardOutbox(f);
      close(f);
      return;
    }
    answerGiveUp(f, false);
    return;
  }
  if (isVerdict(response.status)) {
    // Nothing was given up (no record of this puzzle, a body refused); the round stays open
    // and keeps its conversation. A device signed out elsewhere learns it here too.
    await adoptSignedOutVerdict(response, epoch);
    answerGiveUp(f, false);
    return;
  }
  // A 5xx may have committed: the re-read says.
  resync(f);
}

async function appendBatch(f: RoundFlight, batch: string[]): Promise<void> {
  const puzzle = f.revision;
  let response: Response;
  // THE APPEND NEVER MINTS (#216 trigger rework, user-decided 2026-08-24): the account
  // deploys on the sentence gate's PLAY, so by the time a guess can be typed the identity
  // is in hand. A tokenless append is the pending-bootstrap recovery edge — the outbox
  // stands, and the identity listener pumps every conversation when the deploy lands.
  const request = currentRequestIdentity();
  if (!request) return;
  const { identity } = request;
  const epoch: string = request.epoch;
  try {
    // ROUND CREATION carries a Turnstile challenge (#203). It is prefetched while the
    // puzzle loads, so by the first guess it is normally already in hand; a failure here
    // is an ordinary failed write, retried with the rest — the round keeps playing
    // locally either way, which is why nothing is said on screen.
    const challenge = f.created ? undefined : await turnstileToken();
    // Challenge acquisition is another await. If A left during it, consuming the token is
    // harmless; authenticating A's captured batch as B is not — so this attempt stands
    // down WITHOUT closing (the tokenless append's own shape): an account change resets
    // this engine anyway (identityScope), while a device-only change leaves a round that
    // is still this account's, and closing here wedged its outbox for the tab's life —
    // `retryRoundSync` cannot reopen a settled flight, and nothing else does.
    if (identityEpoch() !== epoch) return;
    response = await postRoundBody(
      roundUrl(f.lang, f.date, f.previewCode),
      requestBody(f, identity.token, batch, challenge),
    );
  } catch {
    // The write never reached an answer — and it may still have COMMITTED (a suspended
    // tab, a dropped connection, a gateway timeout). Re-sending would append the same
    // batch a second time, so the recovery is a RE-READ: only the server can say what it
    // holds, and the outbox shrinks by what that answer shows.
    if (!superseded(f, puzzle, epoch)) resync(f);
    return;
  }

  // Stamp the interval from the ANSWER, whatever it says (see `writeDelayMs`) — and even
  // when the answer is superseded, because the write still LANDED on the same stored
  // item, so the server's next accepted write is an interval past this one either way.
  f.lastWriteSettledAt = Date.now();

  if (response.ok || response.status === 409 || response.status === 429) {
    // All three carry the full stored state (the route's own contract), so all three
    // reconcile the same way — which is what makes a refusal useful rather than merely
    // survivable.
    let state: RoundState;
    let error: string | undefined;
    try {
      const data = (await response.json()) as { error?: unknown };
      error = typeof data.error === 'string' ? data.error : undefined;
      state = parseRound(data);
    } catch {
      if (!superseded(f, puzzle, epoch)) resync(f);
      return;
    }
    // A superseded answer describes the RETIRED puzzle — or an identity this device has
    // left: not its log, not its cap, not its failure count. The republish (or the sign-out)
    // already reset this flight to read again.
    if (superseded(f, puzzle, epoch)) return;
    f.failures = 0;
    // The server holds a record for this puzzle — but only when this answer DEMONSTRATES
    // one (corrected on review). A rate-refused RESTART answers the EMPTY state, because no
    // record of this puzzle exists yet (`stateForTag`); taking that as creation makes the
    // retry omit the round-start challenge, which is a 403, which is a VERDICT — and the
    // conversation closes on a round that was never created. A 200 always created one; a
    // refusal only did if it carried real state, which `createdAt` is the mark of.
    if (response.ok || state.createdAt !== '') f.created = true;
    adopt(f, state, response.ok);

    // The FREEZES (#203/#214, and the give-up): a solved or given-up round accepts nothing
    // more. This answer must do BOTH things — ADOPT the stored state, so the tab renders the
    // round over instead of an unsolved board with its guesses still on screen, and CLOSE,
    // so `pump` does not resend immediately (and, with `failures` reset above, with no
    // backoff at all). What it still had pending was refused, and is dropped for good.
    if (state.solved || state.gaveUp || error === 'round_solved' || error === 'round_given_up') {
      discardOutbox(f);
      close(f);
      return;
    }

    if (response.ok) {
      settleOutbox(f);
      return;
    }

    if (response.status === 409) {
      // Two different 409s wear one status, and only the log the answer CARRIED tells them
      // apart. A stored log at the cap on an unsolved round is the CAP: this round has
      // stopped counting, it ends at `∞`, and anything that never fit is dropped. A 409
      // below the cap merely means the batch OVERSHOT after another device pushed the
      // stored log forward — there the round has room and simply needs a smaller batch, so
      // the outbox stands and `pump` re-sizes from the truth this answer brought.
      //
      // Concluding "capped" from the status alone would end a round that was never full and
      // suppress its leaderboard entry, which is the harshest consequence this design has.
      if (f.server.guesses.length >= ROUND_GUESS_CAP) {
        discardOutbox(f);
        close(f);
      }
      return;
    }
    // A 429 `too_fast` needs nothing more: the outbox stands and the write window now holds
    // the next attempt one full interval past this ANSWER, which is exactly what the server
    // measures against.
    return;
  }

  if (superseded(f, puzzle, epoch)) return;
  if (isVerdict(response.status)) {
    await adoptSignedOutVerdict(response, epoch);
    if (superseded(f, puzzle, epoch)) return;
    close(f);
    return;
  }
  // A 5xx is an unknown outcome like a transport error: it may have committed.
  resync(f);
}

// A 4xx is a VERDICT — a request this client will keep getting wrong (a language the
// server does not serve, a date outside its window, a body the route refuses). Retrying
// it forever spins one request every 30s for the tab's life, and on the READ it also
// stalls every append behind it, so the guesses reach the server on no visit ever. The
// conversation closes instead; the outbox stays in persistent storage and the next visit asks
// once more. (409 and 429 are handled above — they are answers, not verdicts.)
function isVerdict(status: number): boolean {
  return status >= 400 && status < 500;
}

// A load can only ever FAIL before it has succeeded once. After that the board is being
// played, and a failed re-read is an ordinary retry behind it — never a reason to pull an
// interactive screen back to an error state.
function failLoad(f: RoundFlight): void {
  if (f.settled) return;
  useGameStore.getState().setRoundLoad(f.roundKey, { status: 'failed', puzzle: f.revision });
}

function retryLater(f: RoundFlight): void {
  f.failures += 1;
  f.lastFailureAt = Date.now();
  failLoad(f);
}

// The write's outcome is unknown: fall back to the read, which is the only thing that can
// say what the server actually holds, and count the failure so the backoff widens.
function resync(f: RoundFlight): void {
  f.readDone = false;
  f.failures += 1;
  f.lastFailureAt = Date.now();
  // A give-up still waiting on the FLUSH did not go out, so it did not land: answered FALSE
  // now. Left pending, it would wait on appends that may keep failing while every re-read
  // succeeds — a busy button with no end. The outbox keeps retrying as before. (One already
  // SENT is the re-read's to answer: it may have committed.)
  if (f.giveUp && !f.giveUp.sent) answerGiveUp(f, false);
  // Deliberately NOT `failLoad`: the round is already interactive, and an unknown write
  // outcome is a sync hiccup, not a load failure.
}

// A FIRST identity ADOPTED from another tab (#216) invalidates the tokenless projection:
// the ready-and-empty state this engine published without asking was about a device with no
// account, and the adopted account may hold rows this tab has never seen — another tab's
// guesses, a solved board. Every open conversation therefore starts over with a read under
// the new token, exactly as a republish restarts one; the OUTBOX stands, because the guesses
// in it were typed on this device and are owed to the account it now holds. A MINTED first
// identity never comes through here — that account is empty by construction, so the
// tokenless answer stays true (identityScope calls this only on `adopted`).
export function rearmRoundSync(): void {
  for (const [key, f] of flights) {
    answerGiveUp(f, false);
    f.server = EMPTY_ROUND_SERVER;
    f.readDone = false;
    f.settled = false;
    f.created = false;
    f.closed = false;
    f.failures = 0;
    useGameStore.getState().setRoundLoad(key, { status: 'loading', puzzle: f.revision });
    void pump(key);
  }
}

// A first identity ARRIVED — minted by a deploy button, or adopted from another tab: pump
// every open conversation, so an outbox that was waiting behind the PLAY gate flushes
// without waiting for the next guess. The minted case re-reads nothing (the account is
// empty by construction); the adopted case has already been re-armed (`rearmRoundSync`),
// whose own pumps this repeats harmlessly.
export function kickRoundSync(): void {
  for (const key of flights.keys()) void pump(key);
}

// Test seam: drop every conversation (module state must not leak between tests).
export function resetRoundSync(): void {
  for (const f of flights.values()) {
    if (f.timer !== null) clearTimeout(f.timer);
    answerGiveUp(f, false);
  }
  flights.clear();
}
