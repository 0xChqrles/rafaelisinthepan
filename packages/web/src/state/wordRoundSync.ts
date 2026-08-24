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

import { replayWordRun, rankEntry, CLAIM_ZONE } from '../game/wordGame';
import { ROUND_WRITE_MIN_MS, WORD_MISS_CAP, type WordRanks } from '@whippin/shared';
import { parseRound, postRoundBody, roundUrl, type RoundState } from '../api';
import { fnvTag } from './roundSync';
import { EMPTY_ROUND_SERVER, useGameStore, type RoundServer } from './gameStore';
import {
  currentRequestIdentity,
  deviceIdentity,
  ensureRequestIdentity,
  identityEpoch,
  identityEpochOf,
  markDeviceSignedOut,
} from '../identity';
import { turnstileToken } from '../turnstile';

export interface WordRoundContext {
  roundKey: string;
  lang: string;
  date: string;
  // The day's word slug — this daily's puzzle identity (sentence mode instead forwards its
  // published revision). A republished different word restarts the round on both ends.
  word: string;
  ranks: WordRanks;
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

// Which RUNS this session started (PLAY was tapped here and the server stamped a clock).
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
// outcome by a distance. Kept here rather than on the flight so an eviction by
// `pruneFlights` (an archive detour mid-run) does not lose it.
const startedHere = new Set<string>();

// The identity authority is granted for — a round key AND the puzzle it was granted on. A
// round key is only (day, lang, mode), so a re-published different word REUSES it: keyed by
// the round alone, the session that started the RETIRED word would still count as the runner
// of the replacement, and could bury a real player's run under an empty log on a word it
// never played. The same qualification bounds the in-flight `starts` map, whose promise
// otherwise answers a call about one word with the outcome of a call about another.
function runKey(roundKey: string, word: string): string {
  return `${roundKey}#${wordTag(word)}`;
}

// Did this session start THIS word's run? Read by the SCREEN too: the same rule gates the
// day's score submission, which is first-write-wins in exactly the same way.
export function startedRunHere(roundKey: string, word: string): boolean {
  return startedHere.has(runKey(roundKey, word));
}

// May this device write a run it is about to call finished? Yes when it has a log of its
// own — that is a run somebody played here — and yes for the session that started the run,
// which is what lets a real 0-claim run record. Never for a joiner holding nothing.
function mayWrite(ctx: WordRoundContext, tried: readonly string[]): boolean {
  return tried.length > 0 || startedRunHere(ctx.roundKey, ctx.word);
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
// what the route accepts rather than posting a batch it can only be refused for. The local
// outbox keeps everything until acknowledgement; the post-mortem then draws the admissible
// log the server actually stored.
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
    useGameStore.getState().setRoundLoad(key, null);
  }
}

// Where this round's authoritative state is, for the SCREEN (#214): a reload waits for the
// mount read before the run UI resumes, exactly as the sentence board does. The payload is
// also the recorded Word log once the server has accepted one; persisted `tried` is only
// the unacknowledged submission outbox and is cleared on that acknowledgement.
function publishLoad(f: WordFlight, key: string, state?: RoundState): void {
  const server: RoundServer = state
    ? { guesses: state.guesses, solved: false, solvedByAppend: false, credited: false }
    : EMPTY_ROUND_SERVER;
  useGameStore.getState().setRoundLoad(key, { status: 'ready', puzzle: f.puzzle, server });
}

// A load can only ever FAIL before it has succeeded once: after that the run is on screen,
// and a failed retry is a background hiccup rather than a reason to take the clock away.
function failLoad(f: WordFlight, key: string): void {
  if (f.readDone) return;
  useGameStore.getState().setRoundLoad(key, { status: 'failed', puzzle: f.puzzle });
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
      useGameStore.getState().setRoundLoad(ctx.roundKey, { status: 'loading', puzzle });
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
  useGameStore.getState().setRoundLoad(ctx.roundKey, { status: 'loading', puzzle });
  pruneFlights(ctx.roundKey);
  void pump(ctx.roundKey);
}

// The screen's RETRY on a failed load: spend the backoff now, and re-open a conversation a
// verdict closed — the player asked.
export function retryWordRoundSync(roundKey: string): void {
  const f = flights.get(roundKey);
  if (!f) return;
  f.failures = 0;
  f.lastFailureAt = 0;
  if (!f.readDone) {
    f.closed = false;
    useGameStore.getState().setRoundLoad(roundKey, { status: 'loading', puzzle: f.puzzle });
  }
  void pump(roundKey);
}

// PLAY: ask the server to stamp this round's clock, and report whether it did. The screen
// awaits it — the gate holds a loading state until the answer lands, which is what removes
// the skew that starting optimistically would build in: the server would stamp `startedAt`
// an RTT LATER than the visible clock began and therefore see LESS elapsed time than the
// player did, refusing a legitimate run submitting right at its deadline — intermittently,
// on slow connections only, and miserable to diagnose.
export function startWordRound(ctx: WordRoundContext): Promise<boolean> {
  // Per (round, WORD): a start already in the air for a re-published word describes a
  // different daily, and handing its answer back here would report the retired one's
  // outcome for this one.
  const id = runKey(ctx.roundKey, ctx.word);
  const pending = starts.get(id);
  if (pending) return pending;
  const flight = requestStart(ctx).finally(() => {
    if (starts.get(id) === flight) starts.delete(id);
  });
  starts.set(id, flight);
  return flight;
}

async function requestStart(ctx: WordRoundContext): Promise<boolean> {
  const puzzle = wordTag(ctx.word);
  const expectedEpoch = identityEpoch();
  let epoch = expectedEpoch;
  let response: Response;
  try {
    // STARTING A WORD ROUND IS A TRIGGER (#216): a device with no identity mints one here,
    // before the write that stamps the clock. PLAY already waits on this answer, so the
    // bootstrap sits inside a beat the player is already watching.
    const request = await ensureRequestIdentity(expectedEpoch);
    if (!request) return false;
    const { identity } = request;
    epoch = request.epoch;
    // The invisible challenge (web/turnstile.ts) — every failure rejects quietly, and here
    // that is a start the player is told about rather than a silent one: the run cannot
    // begin without it.
    const token = await turnstileToken();
    if (identityEpoch() !== epoch) return false;
    response = await postRoundBody(roundUrl(ctx.lang, ctx.date, 'word'), {
      token: identity.token,
      puzzle,
      turnstileToken: token,
    });
  } catch {
    return false;
  }
  if (identityEpoch() !== epoch) return false;
  if (!response.ok) {
    // PLAY is the first private call a fresh visit makes, so a device revoked since the
    // mount read learns it HERE. Reporting a generic failed start would leave the player
    // tapping a gate that can never open, with nothing saying why.
    await noteVerdict(response, epoch);
    return false;
  }
  let state: RoundState;
  try {
    state = parseRound(await response.json());
  } catch {
    return false;
  }
  const startedAt = anchorFrom(state);
  if (startedAt === null) return false;
  // Is this answer still about the word that asked for it? The daily can be re-published
  // while the request is in the air, and the store has already reset the round to the new
  // word — anchoring the RETIRED word's clock into it (and adopting its log) would start
  // the replacement on a run nobody played. The reader's own round is the check, since a
  // start owns no flight; a superseded start reports failure, and PLAY retries against the
  // word now on screen. The identity half is the same rule (#216): a clock stamped for an
  // account this device has since left must not be anchored into the one that replaced it.
  if (useGameStore.getState().wordRounds[ctx.roundKey]?.word !== ctx.word) return false;
  if (identityEpoch() !== epoch) return false;
  // `running` is answered 200 too: a second tap, a retry or another device resumes the ONE
  // clock the server already stamped, and the store's anchor is idempotent besides. But
  // only a call that actually STAMPED it makes this session the runner — the answer says
  // which (`resumed`). Tapping PLAY while the mount read is still in flight is otherwise
  // enough for a JOINER to claim writer authority over a run it cannot see, and then bury
  // it under an empty log at the base deadline.
  //
  // The narrow cost: a start whose ANSWER was lost and is re-sent comes back `resumed`, so
  // that session is not the runner either. It still writes any run it plays — `mayWrite`
  // takes a non-empty log too — and only a 0-claim run is left unrecorded there.
  if (!state.resumed) startedHere.add(runKey(ctx.roundKey, ctx.word));
  useGameStore.getState().anchorWordRun(ctx.roundKey, startedAt);
  const current = flights.get(ctx.roundKey);
  if (current?.puzzle === puzzle) publishLoad(current, ctx.roundKey, state);
  if (state.submittedAt !== null) settleAuthoritative(ctx, state);
  return true;
}

async function pump(key: string): Promise<void> {
  const f = flights.get(key);
  if (!f || f.closed || f.inFlight) return;

  const round = useGameStore.getState().wordRounds[key];
  if (!round) return;

  const wantsWrite = f.wantSubmit && !round.submitted && mayWrite(f, round.tried);
  if (f.readDone && !wantsWrite) return; // nothing left to say

  const now = Date.now();
  const delay = backoffDelayMs(f.failures, f.lastFailureAt, now);
  if (delay > 0) {
    schedule(key, delay);
    return;
  }

  if (!f.readDone && deviceIdentity() === null) {
    // **No token means no private fetch** (#216): a device with no identity holds no server
    // round, so the mount read has nothing to ask. PLAY is the trigger that creates both.
    publishLoad(f, key);
    f.readDone = true;
    void pump(key);
    return;
  }
  f.inFlight = f.readDone ? submitRun(f, key, round.tried) : readRound(f, key);
  try {
    await f.inFlight;
  } catch {
    // Neither leg is expected to throw — both own their own error paths — but an
    // unexpected one must not escape as an unhandled rejection, and above all must not
    // leave `inFlight` pinned: that wedges this conversation shut for the tab's life.
    retryLater(f, key);
  } finally {
    f.inFlight = null;
  }
  void pump(key); // reassess: the read may have unblocked a pending submission
}

// Is this answer still about the puzzle that asked for it? A flight is MUTATED in place
// when its round re-registers, so a word republished while a request is in the air leaves
// that request describing the retired one. Everything a superseded answer would have
// written is dropped; the flight has already been reset to read again.
function superseded(f: WordFlight, puzzle: string, epoch: string | null): boolean {
  return f.puzzle !== puzzle || epoch !== identityEpoch();
}

async function readRound(f: WordFlight, key: string): Promise<void> {
  const puzzle = f.puzzle;
  const identity = deviceIdentity();
  // `pump` has already taken the tokenless branch, so this can only race a sign-out.
  if (!identity) return;
  const epoch = identityEpochOf(identity);
  let response: Response;
  try {
    response = await postRoundBody(roundUrl(f.lang, f.date, 'word'), {
      token: identity.token,
      puzzle,
    });
  } catch {
    if (!superseded(f, puzzle, epoch)) retryLater(f, key);
    return;
  }
  if (superseded(f, puzzle, epoch)) return;
  if (response.ok) {
    let state: RoundState;
    try {
      state = parseRound(await response.json());
    } catch {
      if (!superseded(f, puzzle, epoch)) retryLater(f, key);
      return;
    }
    // Re-checked after the body: reading it is another await, and a republish landing
    // inside it would leave this state describing the retired word.
    if (superseded(f, puzzle, epoch)) return;
    const startedAt = anchorFrom(state);
    if (startedAt !== null) useGameStore.getState().anchorWordRun(key, startedAt);
    if (state.submittedAt !== null) {
      // The server demonstrably HOLDS a run for this round, so this device owes it
      // nothing — whether the log is its own or the one another device recorded first
      // (the submission is first-write-wins, so a second one would change nothing).
      //
      // Keyed on `submittedAt` and not on the log's length, or a recorded 0-claim run —
      // an EMPTY stored log — would read as unrecorded on every visit forever.
      settleAuthoritative(f, state);
    }
    publishLoad(f, key, state);
  } else if (response.status === 404) {
    // The server holds nothing for THIS word: an unplayed day, or one republished under the
    // same key whose old record is retired. Nothing to resume; PLAY will create it.
    publishLoad(f, key);
  } else if (isVerdict(response.status)) {
    // A device signed out from elsewhere learns it here, on the mount read. The screen it
    // raises is the whole answer; this conversation has nothing left to ask.
    await noteVerdict(response, epoch);
    if (superseded(f, puzzle, epoch)) return;
    failLoad(f, key);
    f.closed = true;
    return;
  } else {
    retryLater(f, key);
    return;
  }
  f.readDone = true;
  f.failures = 0;
}

// A 4xx may be the signed-out answer (#216). The CODE decides, never the status: a device
// must not be signed out for a body this route refused for any other reason, and a 5xx or a
// dropped connection must never sign anyone out at all.
async function noteVerdict(response: Response, epoch: string): Promise<void> {
  if (response.status !== 401) return;
  try {
    const data = (await response.json()) as { error?: unknown };
    if (data.error === 'unknown_device') markDeviceSignedOut(epoch);
  } catch {
    // A refusal with no readable body says nothing about the device.
  }
}

async function submitRun(f: WordFlight, key: string, tried: readonly string[]): Promise<void> {
  const puzzle = f.puzzle;
  // A run this device PLAYED always has an identity — the START minted one — and since the
  // #216 trigger rework the submission never mints its own: only the deploy buttons do. A
  // tokenless submission describes a run this identity cannot own, so it stands down.
  const request = currentRequestIdentity();
  if (!request) {
    f.closed = true;
    return;
  }
  const { identity } = request;
  const epoch: string = request.epoch;
  let response: Response;
  try {
    response = await postRoundBody(roundUrl(f.lang, f.date, 'word'), {
      token: identity.token,
      puzzle,
      guesses: submittableLog(f.ranks, tried),
    });
  } catch {
    if (!superseded(f, puzzle, epoch)) retryLater(f, key);
    return;
  }
  if (superseded(f, puzzle, epoch)) return;

  let state: RoundState | null = null;
  let error: string | undefined;
  try {
    const data = (await response.json()) as { error?: unknown };
    error = typeof data.error === 'string' ? data.error : undefined;
    state = parseRound(data);
  } catch {
    state = null;
  }
  if (superseded(f, puzzle, epoch)) return;

  if (response.ok) {
    // 200 covers the SUBMISSION and the "already submitted" answer alike: the daily is
    // one-shot and cannot be replayed, so the FIRST write stands and this device owes the
    // server nothing further either way. Its returned log is truth even when another
    // device won the first write: publish that snapshot, then clear this device's now-
    // acknowledged outbox. A malformed 2xx cannot acknowledge anything safely; retrying
    // is idempotent and the next "already submitted" answer returns the same truth.
    if (!state) {
      retryLater(f, key);
      return;
    }
    publishLoad(f, key, state);
    settleAuthoritative(f, state);
    f.closed = true;
    return;
  }
  // `too_early` is the one refusal worth waiting out: the wait check is the game's own
  // floor, so honest play cannot hit it, but a clock that disagrees by a second or two
  // can — and retrying a moment later succeeds. Every other 4xx is a VERDICT (no run was
  // ever started here; a body this client keeps getting wrong), and retrying it forever
  // would spin one request every 30 seconds for the tab's life.
  if (error !== 'too_early' && isVerdict(response.status)) {
    if (isVerdictSignedOut(response.status, error)) markDeviceSignedOut(epoch);
    f.closed = true;
    return;
  }
  retryLater(f, key);
}

// Adopt what the server holds as this round's authoritative RECORDED run. The persisted
// local log is only an outbox: a successful submission acknowledges and clears it even
// when first-write-wins returns another device's spelling or a zero-claim empty log.
function settleAuthoritative(ctx: WordRoundContext, state: RoundState): void {
  const run = replayWordRun(ctx.ranks, state.guesses);
  useGameStore.getState().settleWordRun(ctx.roundKey, run.claimed.length);
}

// The submission path has already read the refusal's body, so it names the code directly.
function isVerdictSignedOut(status: number, error: string | undefined): boolean {
  return status === 401 && error === 'unknown_device';
}

// A 4xx is a VERDICT — a request this client will keep getting wrong. (409 `too_early` is
// handled above: it is an answer about WHEN, not about the request.)
function isVerdict(status: number): boolean {
  return status >= 400 && status < 500;
}

function retryLater(f: WordFlight, key: string): void {
  f.failures += 1;
  f.lastFailureAt = Date.now();
  failLoad(f, key);
}

// A FIRST identity ADOPTED from another tab (#216): the tokenless mount answer published a
// ready-and-empty round, but the adopted account may hold a live or recorded run this tab
// has never seen — and leaving the projection standing offers PLAY for a one-shot daily the
// account already spent. Re-read every open conversation under the new token (the
// roundSync rule); the persisted clock/outbox and the runner-authority maps stand — they
// describe what THIS device played, which adoption does not change. A MINTED first identity
// never comes through here (identityScope calls this only on `adopted`).
export function rearmWordRoundSync(): void {
  for (const [key, f] of flights) {
    f.readDone = false;
    f.closed = false;
    f.failures = 0;
    useGameStore.getState().setRoundLoad(key, { status: 'loading', puzzle: f.puzzle });
    void pump(key);
  }
}

// Test seam: drop every conversation (module state must not leak between tests).
export function resetWordRoundSync(): void {
  for (const f of flights.values()) if (f.timer !== null) clearTimeout(f.timer);
  flights.clear();
  starts.clear();
  startedHere.clear();
}
