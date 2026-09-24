// The round route on the ONE handler: POST /round?lang=&date=.
//
// The client STREAMS its guess log (#201):
//   { token, puzzle }                 — your stored round for that daily (404 = none yet);
//   { token, puzzle, guesses: [...] } — append to its ordered guess log.
//
// Every call answers with the FULL stored state `{ guesses, createdAt, progress?, solved? }`
// — a 200 and EVERY refusal — so a write is also a reconciliation: the caller computes
// against stale local state, the server answers with truth, and the tab re-renders correct.
// The route is POST-only — the device token is the auth (#216) and
// it travels in the BODY, never in a query string, so there is no way to ask without proving
// who you are. Its CloudFront behavior forwards exactly the two addressing queries (the
// root AGENTS.md allowList contract); a production POST still needs
// `x-amz-content-sha256` over the exact body bytes (OAC).
//
// `puzzle` is the opaque tag naming WHICH puzzle the log belongs to (roundStore.ts): the
// server only ever compares it, which is the same "stores strings, interprets nothing"
// rule the log itself follows.
//
// Since #203 the append READS THE DAY'S PUZZLE — overturning #201's explicit "there is NO
// puzzle-store read". The score stops being something the client claims: the server derives
// `progress` and `solved` from the stored log on every append and records the score row
// itself when the round finishes. What it reads is the small DERIVATION SLICE (slice.ts),
// not the multi-megabyte artifact — and the full artifact only when a round actually
// solves, because only the score needs every rank.

import {
  activeDate,
  countTries,
  dayNumber,
  fold,
  isBonusAddress,
  ROUND_GUESS_CAP,
  VOCAB_BUILDS,
  type Puzzle,
} from '@whippin/shared';
import { createHash } from 'node:crypto';
import {
  clientIp,
  LIVE_HEADERS,
  readJsonObject,
  requireDayParams,
  requireDevice,
  requireTurnstileToken,
} from './liveRoute';
import type { DeviceStore } from './deviceStore';
import type { PlayerHistoryStore } from './historyStore';
import { loadPuzzle, loadSlice } from './puzzleReads';
import { deriveRound, type PuzzleSlice } from './slice';
import {
  PUZZLE_TAG_SHAPE,
  type RoundKey,
  type RoundState,
  type RoundStore,
} from './roundStore';
import { hashClientIp } from './scores';
import { SCORE_DEDUP_TTL_SECONDS, type ScoreStore } from './scoreStore';
import { errorResponse, json, type FnUrlEvent, type FnUrlResult } from './respond';
import type { PuzzleStore } from './store';
import type { TurnstileVerifier } from './turnstile';

export interface RoundHandlerDeps {
  roundStore: RoundStore;
  // No DeviceStore here: every path is authenticated (#216), but the caller resolves
  // through the ONE top-level `HandlerDeps.deviceStore` — the handler passes it in, so
  // this route can never authenticate against a different store than its siblings.
  // Since #203 a finished round records its OWN score row — there is no score POST left to
  // do it (the client-claimed score and its range validation are retired), so the day's
  // population is written from here.
  scoreStore: ScoreStore;
  // The #169 volume floor under those rows moved here with the write: the round path is
  // where a score is now recorded, so it is where the address is hashed.
  ipHmacSecret: string;
  // Turnstile gates ROUND START (#203 moved it off the score POST): the append that CREATES
  // a round. Round creation is available to every unlinked visitor, so it carries more
  // weight than it did.
  turnstile: TurnstileVerifier;
  // The streak's solved-day collection (#211). A confirmed solve credits its day
  // here, idempotently, so the private history read can answer the streak without replaying
  // a year of round rows. It is a rebuildable CACHE of those rows, never a second
  // authority — which is what makes crediting it a fire-and-log side effect below.
  history: PlayerHistoryStore;
  // Only the direct local HTTP adapter may trust its socket peer (the /scores rule).
  allowSourceIp?: boolean;
}

// The biggest body this route reads: one coalesced flush is bounded by the guess cap itself,
// so at most that many slugs of at most the longest language's maxSlugLength (#200) plus JSON
// framing (`"…",`), with slack for the device token, the puzzle tag, a Turnstile token and the
// field names. DERIVED rather than hand-picked, so a longer vocabulary cannot silently
// outgrow it — still small, since the point is bounding JSON.parse rather than serving
// uploads.
const LONGEST_SLUG = Math.max(...Object.values(VOCAB_BUILDS).map((build) => build.maxSlugLength));
const BODY_MAX_BYTES = ROUND_GUESS_CAP * (LONGEST_SLUG + 3) + 4_096;

export async function handleRound(
  event: FnUrlEvent,
  puzzleStore: PuzzleStore,
  devices: DeviceStore,
  deps: RoundHandlerDeps,
  serverDate: string,
  instant: Date,
  cors: Record<string, string>,
): Promise<FnUrlResult> {
  const responseHeaders = { ...cors, ...LIVE_HEADERS };
  const rounds = deps.roundStore;
  const method = event.requestContext?.http?.method ?? 'GET';
  if (method !== 'POST') {
    return errorResponse(
      405,
      'method_not_allowed',
      'The round route is POST-only: the device token authenticates in the body.',
      responseHeaders,
    );
  }

  // The shared (lang, date) guard pair + future guard (liveRoute.ts); a BONUS puzzle's id
  // may stand in for the date, which is then the bonus's address (shared bonus.ts).
  const params = requireDayParams(event, serverDate, responseHeaders, { bonus: true });
  if (!params.ok) return params.response;
  const { lang, date } = params.value;

  const parsed = readJsonObject(event, 'Round', responseHeaders, BODY_MAX_BYTES);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;

  // Validated BEFORE authentication: it costs no I/O, and knowing the tag is what lets
  // the hot append start its slice fetch beside the auth reads below.
  const puzzle = body.puzzle;
  if (typeof puzzle !== 'string' || !PUZZLE_TAG_SHAPE.test(puzzle)) {
    return errorResponse(
      400,
      'bad_request',
      'Body field "puzzle" must be the short tag naming this daily\'s puzzle.',
      responseHeaders,
    );
  }

  // The game's hottest write pays latency directly: the web paces its flushes from the
  // previous write's ANSWER, so every serial round trip here cuts the sustained sync rate.
  // Authentication is two sequential DynamoDB reads since #216 (the device row, then its
  // account row); the append's derivation slice (#203) depends on neither, so its S3 GET
  // starts FIRST and hides inside them — the same overlap #203 built against the round read.
  // The plain read still awaits auth alone: everything it fetches needs the resolved account.
  const slicePromise =
    body.guesses !== undefined ? loadSlice(puzzleStore, date, lang, puzzle) : null;
  // A path that returns before awaiting it (a refused auth, a malformed batch) must not
  // leave the rejection unhandled; the append path awaits the ORIGINAL promise, so a real
  // failure still surfaces there.
  slicePromise?.catch(() => {});

  const auth = await requireDevice(body, responseHeaders, devices, instant);
  if (!auth.ok) return auth.response;
  const publicId = auth.value.account.accountId;

  const rawGuesses = body.guesses;
  if (body.turnstileToken !== undefined && rawGuesses === undefined) {
    // A round is created BY its first append, so a bare token names no write. It is a
    // protocol violation rather than a free challenge to burn.
    return errorResponse(
      400,
      'bad_request',
      'A round starts with its first append: the token rides that append.',
      responseHeaders,
    );
  }
  if (rawGuesses === undefined) {
    // READ: the caller's stored round FOR THIS PUZZLE. A 404 is the honest "nothing
    // yet" — a fresh round (or a re-published daily whose old log is retired), local
    // state authoritative until the first write lands.
    const state = await rounds.get({ date, lang }, publicId, puzzle);
    if (!state) {
      return errorResponse(404, 'not_found', 'No round recorded.', responseHeaders);
    }
    return json(200, state, responseHeaders);
  }

  // WRITE: validate before touching the store — a malformed batch is a protocol violation,
  // never a partial write.
  if (
    !Array.isArray(rawGuesses) ||
    rawGuesses.length === 0 ||
    rawGuesses.length > ROUND_GUESS_CAP ||
    !rawGuesses.every((g) => typeof g === 'string')
  ) {
    return errorResponse(
      400,
      'bad_request',
      `Body field "guesses" must be an array of at most ${ROUND_GUESS_CAP} strings.`,
      responseHeaders,
    );
  }
  const maxLength = VOCAB_BUILDS[lang].maxSlugLength;
  const guesses = rawGuesses as string[];
  // What a guess IS on the wire: a folded slug, bounded by the language's own vocabulary
  // record (#200). The check ASKS THE CONTRACT rather than restating its pipeline as a
  // local regex — a folded form is exactly one `fold()` leaves alone — so this cannot
  // become a third spelling of slug()/fold() free to drift from the two that matter.
  if (!guesses.every((g) => g.length > 0 && g.length <= maxLength && fold(g) === g)) {
    return errorResponse(
      400,
      'bad_request',
      `Every guess must be a folded slug of at most ${maxLength} characters.`,
      responseHeaders,
    );
  }

  const key: RoundKey = { date, lang };
  // The two reads the derivation needs, CONCURRENTLY: neither depends on the other, so the
  // slice's GET — started above, before authentication — hides inside round trips already
  // being paid for. The round read is EVENTUALLY consistent (roundStore.ts states why that
  // is enough here). The slice is the revision the CALLER is playing: an artifact
  // describing another one is refused rather than derived against (puzzleReads.ts).
  const [seen, slice] = await Promise.all([
    rounds.get(key, publicId, puzzle, { consistent: false }),
    slicePromise ?? loadSlice(puzzleStore, date, lang, puzzle),
  ]);
  if (!slice) {
    // A missing slice IS a missing puzzle — there is no degraded mode: either publishing
    // failed, or the day was never published, or this caller is still on a revision the
    // store has replaced. All three are the same day-addressed answer.
    return errorResponse(404, 'not_found', `No puzzle for ${date} (${lang}).`, responseHeaders, {
      date,
      lang,
    });
  }

  // Turnstile gates ROUND CREATION (#203): the token moved off the retired score POST, and
  // an unlinked visitor can now mint state here. A missing record covers both cases that
  // create one — a fresh round, and one whose stored log names a RETIRED puzzle and is about
  // to be replaced. An append to a record that already exists costs no challenge.
  //
  // But the read above is EVENTUALLY consistent, so its `null` is not evidence (corrected on
  // review). A stale one demands a challenge the client has no reason to send — it only ever
  // carries one on the append it believes creates the round — so the write is refused 403,
  // which the client reads as a VERDICT and closes the conversation on, for the rest of that
  // tab's life. One strongly consistent confirmation before demanding anything: it costs a
  // read on the rare path that looks like creation, and nothing on the common one.
  let stored = seen;
  if (!stored) {
    stored = await rounds.get(key, publicId, puzzle);
    if (!stored) {
      const gate = await requireRoundStart(body, event, deps, responseHeaders);
      if (gate) return gate;
    }
  }

  // Derived from what THIS caller can see: the stored log for this puzzle plus the batch.
  // A record naming a retired puzzle answers `null` above, so the batch REPLACES the log
  // and the derivation describes exactly that.
  const derived = deriveRound(slice, [...(stored?.guesses ?? []), ...guesses]);

  // EARLY PLAY (#273, user-decided 2026-09-08): a round whose date is AFTER this server's
  // active day — the +1-day window `requireDayParams` already admits — is tomorrow's
  // sentence being started tonight, and the night's play ends at the first progress or at
  // `EARLY_GUESS_CAP` guesses. The store enforces both inside the append's own condition;
  // this is the one place that knows the server's day, so it is where the round is told.
  // Judged on the SERVER's clock, like `onTime`: the client's own reading of the flip is
  // what it locks its input on, and a skewed device is refused here rather than trusted.
  const early = !isBonusAddress(date) && dayNumber(date) > dayNumber(serverDate);

  // The atomic store guard checks progress BEFORE this batch. Reject a batch that
  // itself continues past an improvement; otherwise three secrets could solve early.
  // Progress is monotonic, so checking the prefix before the last guess is enough.
  // Refuse the whole batch, preserving the append's all-or-nothing contract.
  if (early && guesses.length > 1 && deriveRound(slice, guesses.slice(0, -1)).progress > 0) {
    return refusal(
      409,
      'early_locked',
      'This batch continues past the first early-play improvement.',
      (await rounds.get(key, publicId, puzzle)) ?? { guesses: [], createdAt: '' },
      responseHeaders,
    );
  }

  const { outcome, state } = await rounds.append({
    date,
    lang,
    publicId,
    guesses,
    puzzle,
    progress: derived.progress,
    solved: derived.solved,
    early,
    now: instant,
  });
  if (outcome === 'early_locked') {
    // The night's play is over (#273): the guess that made progress is STORED — it is
    // what moved `progress` — and this one is refused. The client adopts and CLOSES, the
    // `round_solved` shape: what it still held pending was never stored, and the day
    // itself is what unlocks the round, not a retry.
    return refusal(
      409,
      'early_locked',
      `This round is played before its day and accepts no further guesses until ${date}.`,
      state,
      responseHeaders,
    );
  }
  if (outcome === 'round_solved') {
    // The FREEZE (#203): this round is finished and its score is recorded, so nothing more
    // may join its log. The client must do BOTH things here — ADOPT the state (so the tab
    // renders the round solved instead of showing an unsolved board with its guesses still
    // on screen) and CLOSE the conversation (so it stops asking). Its unsent guesses are
    // dropped for good; harmless to the score, since fewer tries is a better one.
    return refusal(
      409,
      'round_solved',
      'This round is solved and accepts no further guesses.',
      state,
      responseHeaders,
    );
  }
  if (outcome === 'round_full') {
    // The refusal means THIS BATCH does not fit, which is not always "the round is
    // full": a batch sized against a stale view of the log (another device pushed it
    // forward meanwhile) overshoots a round that still has room. The stored log itself
    // says which — and only the genuine one is the puzzle-curation signal (#201): a real
    // player reaching the cap means an unreachable secret, available no other way. The
    // client stops after that refusal, so each hit is one honest line rather than spam —
    // and gating the line here is what keeps a racing second device out of the count.
    const full = state.guesses.length >= ROUND_GUESS_CAP;
    if (full) {
      console.warn(
        `[round] round_full: ${date} ${lang} ${publicId} refused ` +
          `${guesses.length} further guess(es) past the ${ROUND_GUESS_CAP}-guess cap.`,
      );
    }
    return refusal(
      409,
      'round_full',
      full
        ? `This round already holds the maximum of ${ROUND_GUESS_CAP} guesses.`
        : `This batch of ${guesses.length} would push the round past ${ROUND_GUESS_CAP} guesses.`,
      state,
      responseHeaders,
    );
  }
  if (outcome === 'too_fast') {
    return refusal(
      429,
      'too_fast',
      // Per DAILY, not per player: `lastWriteAt` lives on the round item, which is the
      // granularity the client paces at too (root AGENTS.md).
      'Guess writes are limited to about one per second for this daily.',
      state,
      // Exposed to script by the CORS headers: a browser can read no response header
      // outside the safelist without it, so an unexposed Retry-After is a value only
      // curl and `backend:dev` ever see.
      { ...responseHeaders, 'Retry-After': '1' },
    );
  }
  // APPENDED. The write is atomic, but the read -> derive -> write sequence is not, so what
  // it stored may already describe a log one batch out of date. Verify against the log the
  // append RETURNED before answering (roundStore.ts `RoundSettleInput` states the race).
  return await settleAppend(
    { key, publicId, puzzle, slice, state },
    puzzleStore,
    deps,
    event,
    instant,
    responseHeaders,
  );
}

// The Turnstile gate on a ROUND START (#203). Returns the refusal to answer with, or null
// when the caller may create the round: the one write that mints state for a caller who has
// done nothing yet.
async function requireRoundStart(
  body: Record<string, unknown>,
  event: FnUrlEvent,
  deps: RoundHandlerDeps,
  headers: Record<string, string>,
): Promise<FnUrlResult | null> {
  const token = requireTurnstileToken(body, headers);
  if (!token.ok) return token.response;
  const remoteIp = clientIp(event, deps.allowSourceIp === true);
  if (!remoteIp) {
    throw new Error('Round start has no trusted client IP address.');
  }
  if (!(await deps.turnstile.verify(token.value, remoteIp))) {
    return errorResponse(403, 'turnstile_rejected', 'Turnstile token is invalid.', headers);
  }
  return null;
}

interface AppendedRound {
  key: RoundKey;
  publicId: string;
  puzzle: string;
  slice: PuzzleSlice;
  state: RoundState;
}

// What an ACCEPTED append still owes, before it answers.
//
// `list_append` and its condition are one operation and cannot be raced — but the values
// written beside them were derived from a snapshot taken BEFORE it, and deriving from
// *(my read + my batch)* misses a solve that exists only in the UNION of two concurrent
// batches. The append returns the true merged log (`ReturnValues: ALL_NEW`), so the check
// costs no extra read: derive again from what came back and, when it disagrees, correct it.
//
// The pre-read STAYS: it is what supplies values to write in the same operation, which is
// what holds this at one read plus one write. The returned item is a VERIFICATION, not a
// replacement — normally it agrees and nothing more happens.
async function settleAppend(
  round: AppendedRound,
  puzzleStore: PuzzleStore,
  deps: RoundHandlerDeps,
  event: FnUrlEvent,
  instant: Date,
  headers: Record<string, string>,
): Promise<FnUrlResult> {
  const { key, publicId, puzzle, slice, state } = round;
  const truth = deriveRound(slice, state.guesses);
  // What the append itself already made durable.
  let solveIsStored = state.solved === true;
  const solveNeedsWrite = truth.solved && !solveIsStored;
  if (truth.progress !== state.progress || solveNeedsWrite) {
    // The LAST chance to record this solve, so it is RETRIED rather than fired and
    // forgotten: once the puzzle is solved the player stops guessing, so no later append
    // will come along to notice the omission — a dropped corrective write leaves exactly
    // the outcome this whole check exists to prevent, reached by a rarer route. The same
    // comparison fixes `progress`, whose "lands slightly low and the next write corrects
    // it" only holds while there IS a next write.
    if (await confirmWrite(() =>
      deps.roundStore.settle({ ...key, publicId, puzzle, progress: truth.progress, solved: truth.solved }),
    )) {
      state.progress = truth.progress;
      if (truth.solved) {
        state.solved = true;
        solveIsStored = true;
      }
    } else if (solveNeedsWrite) {
      // **The write did not land, so the solve is NOT durable** (corrected on review: this
      // used to answer `solved: true` regardless, which recorded a score, told the client
      // the round was frozen, and closed its conversation — over a row DynamoDB still reads
      // as unsolved and still accepts appends). The answer below therefore carries the state
      // as STORED, no score is recorded, and the client keeps its conversation open. What is
      // lost is this round's standing, which is the honest outcome of a solve nothing kept.
      //
      // "Did not land" covers a REFUSED write as well as a failing one (corrected again on
      // review): a concurrent republish makes the record name another puzzle, the condition
      // declines, and swallowing that as success claimed a solve the record never took.
      console.error(
        `[round] solve NOT recorded (corrective write failed): ${key.date} ${key.lang} ${publicId}.`,
      );
    }
  }
  // The round FINISHED on this append — and only ONE append ever can, because the freeze
  // refuses every later one, so this fires once per round. Note it is keyed on the RETURNED
  // log rather than on what this caller derived: in the two-device race the solve exists
  // only in the union, and the write that lands second is the one that sees it.
  //
  // Gated on the solve being STORED, not merely derived: within this published version the
  // score is first-write-wins, so recording one beside a round row that says unsolved would
  // put the two stores into exactly the disagreement this design keeps out of them.
  //
  // Recording it is the last thing the append does, so the answer the client adopts is never
  // ahead of the population it is about to read.
  if (truth.solved && solveIsStored) {
    // ON TIME (below) gates BOTH of the day's rewards, and it is decided HERE, before
    // either side effect runs: a late solve (an archive replay, a round carried past the
    // 22:00 flip) must not load the multi-megabyte scoring artifact only for
    // `recordScoreRow` to discard the work at its own gate — archive days are explicitly
    // playable, so that is a live path, not a corner.
    const earned = onTime(key.date, instant);
    let credited = false;
    if (earned) {
      // The two rewards are INDEPENDENT — neither reads the other, and each swallows its
      // own failures — so they share the round trip instead of queuing on it: this is the
      // one response the solving device's celebration is waiting on.
      [credited] = await Promise.all([
        creditSolvedDay(round, deps),
        recordScore(round, puzzleStore, deps, event, instant),
      ]);
    }
    // The answer that confirms a solve also says whether it EARNED the day (#211's streak
    // credit and the leaderboard row wear one predicate). The client's celebration rides
    // this flag rather than re-making the comparison on its own clock: a device inside the
    // +1-day skew window would otherwise celebrate a streak day the server refused, and
    // the transient collection can never take a phantom day back out. For the same reason
    // it reports the credit's OUTCOME, not merely the on-time verdict: a collection write
    // that failed answers false, or the client celebrates and transiently holds a day the
    // server's collection lost — the exact phantom the flag exists to prevent. The score
    // row stays independent and silent: a missing standing, never a withheld celebration.
    return json(200, { ...state, credited }, headers);
  }
  return json(200, state, headers);
}

// **ON TIME MEANS ON THE DAY, and LATE HAS NO GRADATIONS** (user-decided 2026-08-23): a
// millisecond late is a decade late. A round only earns the day's rewards — the streak
// credit AND the leaderboard row — when the day it is playing IS the day it was PLAYED on:
// the day the solving append lands. A sentence carried across the 22:00 flip and finished at
// 22:00:01 was not finished on time; an archive replay never was on time at all; and the two
// are the same thing.
//
// That single rule replaced a window tolerating `activeDay - 1` for the flip-edge, plus a
// second gate in the CLIENT (the route) to tell that edge from a deliberate archive replay
// of yesterday. The two are NUMERICALLY IDENTICAL, and the only thing that ever separated
// them was which URL the tab was on — knowledge that exists in the browser and nowhere
// else, so the server could never have applied the tolerance honestly. Ruling the edge late
// removes the ambiguity rather than arbitrating it, which is why one predicate can now
// serve every reward the day has.
//
// `activeDate(instant)` IS the `serverDate` the handler guards with — the same function on
// the same instant — so this asks the day question rather than being told the answer.
function onTime(date: string, instant: Date): boolean {
  // A BONUS puzzle (shared bonus.ts) is no day: never on time, so it earns no score row and
  // no streak credit — the one check both rewards pass through.
  return !isBonusAddress(date) && date === activeDate(instant);
}

// THE STREAK's own fact (#211): this language's collection of solved game days, credited
// when the server CONFIRMS a solve, and only when that solve was ON TIME — the caller
// (`settleAppend`) makes that one `onTime` check for BOTH rewards before either runs.
// Idempotent by construction (a set insert), so a re-published daily solved again, or a
// corrective write re-recording a round the store already holds, adds the day once — which
// is also why solving a corrected revision cannot claim a day twice, and why a republish
// never takes back a day already credited.
//
// FAILURE IS SILENT to the append, and that is the point of the collection being a
// rebuildable cache: the guesses are stored, the solve is durable on the round row, and a
// streak day that could not be cached is a stat, never a refused append. It is NOT silent
// to `credited`, though — the return says whether the credit actually LANDED, because the
// client's celebration and its transient day ride that flag, and a day held on a write
// that failed is a phantom the union merge can never remove.
async function creditSolvedDay(round: AppendedRound, deps: RoundHandlerDeps): Promise<boolean> {
  const { key, publicId } = round;
  const solvedDay = dayNumber(key.date);
  try {
    await deps.history.recordSolvedDay({ publicId, lang: key.lang, day: solvedDay });
    return true;
  } catch (error) {
    console.error(`[round] failed to credit the streak day ${key.date} (${key.lang}):`, error);
    return false;
  }
}

// THE SCORE, derived rather than claimed (#203). It counts UNIQUE tries, and `guessKey`
// dedups on a guess's rank in EVERY map — so this is the one thing the slice cannot answer
// and the full artifact has to be loaded for. It happens ONCE per round, and the artifact is
// read FRESH. A corrected published version starts a new round and replaces this player's
// retired-version score row (puzzleReads.ts).
//
// Every failure here is SILENT to the caller. The guesses are stored, the round is settled,
// and the answer is about the LOG; a population that could not be written is a missing
// standing, never a refused append.
async function recordScore(
  round: AppendedRound,
  puzzleStore: PuzzleStore,
  deps: RoundHandlerDeps,
  event: FnUrlEvent,
  instant: Date,
): Promise<void> {
  const { key, publicId, state } = round;
  // The load is guarded too, not just the write: the store only swallows NotFound, so a
  // throttle or a transient S3 5xx THROWS — and a throw escaping here would 500 an append
  // that already committed and froze the round, losing the score row for good (the freeze
  // means no later append ever retries it).
  let puzzle: Puzzle | null;
  try {
    puzzle = await loadPuzzle(puzzleStore, key.date, key.lang, round.puzzle);
  } catch (error) {
    console.error(
      `[round] failed to load the puzzle to score ${key.date} ${key.lang} for ${publicId}:`,
      error,
    );
    return;
  }
  if (!puzzle) {
    console.error(`[round] no puzzle to score ${key.date} ${key.lang} for ${publicId}.`);
    return;
  }
  await recordScoreRow(
    key,
    publicId,
    countTries(puzzle.ranks, state.guesses),
    round.puzzle,
    deps,
    event,
    instant,
  );
}

// One recorded score per player per daily (#187), written by the SERVER now that the log
// is (#203).
//
// **A LATE finish records NOTHING** (user-decided 2026-08-23). The gate lives here because
// it is one rule about the day's competition: a leaderboard is a day's, so a round not
// played on it is not competing in it, whether by a millisecond or by ten years. An archive
// replay therefore records no row and draws no standing — `/scores` answers `bucket: null`
// for a caller the population does not hold, and the solved screen simply shows no rank
// line. It also stops spending a #169 address allowance on a day nobody is competing in.
//
// Every failure here is SILENT to the caller. The guesses are stored and the answer is
// about the LOG; a population that could not be written is a missing standing, never a
// refused write.
async function recordScoreRow(
  key: RoundKey,
  publicId: string,
  score: number,
  // The version of the daily this score was earned on — the round's own tag (#203).
  revision: string,
  deps: RoundHandlerDeps,
  event: FnUrlEvent,
  instant: Date,
): Promise<void> {
  try {
    if (!onTime(key.date, instant)) return;
    // The #169 volume floor, unchanged in shape: the address is HMACed and only the digest
    // reaches the store. A caller with no trusted address cannot be metered, so its score
    // is not recorded — the same stance the retired score POST took.
    const remoteIp = clientIp(event, deps.allowSourceIp === true);
    if (!remoteIp) {
      console.error(`[round] no trusted address to meter ${key.date} ${key.lang} ${publicId}.`);
      return;
    }
    const outcome = await deps.scoreStore.submit({
      ...key,
      publicId,
      score,
      submittedAt: instant.toISOString(),
      revision,
      ipHash: hashClientIp(remoteIp, deps.ipHmacSecret),
      expiresAt: Math.floor(instant.getTime() / 1000) + SCORE_DEDUP_TTL_SECONDS,
      // The row is first-write-wins per VERSION and unique per (daily, player), so its own
      // key is a perfect DynamoDB idempotency token — where the retired POST hashed a
      // single-use Turnstile token this write does not have. The REVISION is part of it:
      // without it, a corrected round's submission looks to DynamoDB like a replay of the
      // retired one's and is silently dropped before its condition is ever evaluated.
      requestToken: createHash('sha256')
        .update(`${key.date}#${key.lang}#${publicId}#${revision}`)
        .digest('hex')
        .slice(0, 36),
    });
    if (outcome === 'capped') {
      console.warn(`[round] score not recorded (IP allowance): ${key.date} ${key.lang}.`);
    }
  } catch (error) {
    console.error(`[round] failed to record the score for ${key.date} ${key.lang}:`, error);
  }
}

// A write that must not be dropped, and whose CONFIRMATION the caller owes a check: an
// outcome this route claims in its answer has to be one the store actually holds.
//
// The two ways it can fail are not the same thing. A THROW is transport — two retries with a
// short backoff ride out a throttle, bounded so it can never hold a player's append open.
// A `false` is the store's CONDITION declining, which is a verdict: retrying cannot change
// what the record now says, so it is reported straight back.
async function confirmWrite(write: () => Promise<boolean>): Promise<boolean> {
  const delays = [50, 150];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await write();
    } catch (error) {
      if (attempt >= delays.length) {
        console.error('[round] corrective write failed after retries:', error);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

// A refusal is an ANSWER: it carries the UNCHANGED stored state, which is already the
// truth the client reconciles against. That is also what pays for the extra consistent
// read the Dynamo store spends classifying one — without it, the read exists only to
// choose between two status codes and the client stays stale until its next accepted
// write.
function refusal(
  statusCode: number,
  error: string,
  message: string,
  state: RoundState,
  headers: Record<string, string>,
): FnUrlResult {
  return errorResponse(statusCode, error, message, headers, { ...state });
}
