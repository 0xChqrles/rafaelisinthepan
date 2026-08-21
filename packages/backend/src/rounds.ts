// The round route on the ONE handler: POST /round?lang=&date=&mode=.
//
// SENTENCE mode STREAMS its guess log (#201):
//   { secret, puzzle }                 — your stored round for that daily (404 = none yet);
//   { secret, puzzle, guesses: [...] } — append to its ordered guess log.
//
// WORD mode writes exactly TWICE (#202) — the intuition says the opposite, but the fast
// game benefits least: what syncing buys is the live friends board, and a 60-second run is
// over before anyone opens it.
//   { secret, puzzle, turnstileToken } — START: stamp this round's clock from the SERVER's
//                                        own clock, onto the same record. Its answer adds
//                                        `resumed`: false when THIS call stamped it, true
//                                        when it joined a clock already running;
//   { secret, puzzle, guesses: [...] } — SUBMIT the whole log, once, at the end of the run.
//
// Every call answers with the FULL stored state `{ guesses, createdAt, startedAt?, now }` —
// a 200 and EVERY refusal — so a write is also a reconciliation: the caller computes
// against stale local state, the server answers with truth, and the tab re-renders correct.
// `now` is the server's own clock at the moment it answered, which is what lets a client
// anchor its countdown to the server's `startedAt` without trusting its own device clock.
// The route is POST-only for the /friends reason — the secret is the auth (#187) and it
// travels in the BODY, never in a query string, so there is no way to ask without proving
// who you are. Its CloudFront behavior forwards exactly the three addressing queries (the
// root AGENTS.md allowList contract); a production POST still needs
// `x-amz-content-sha256` over the exact body bytes (OAC).
//
// `puzzle` is the opaque tag naming WHICH puzzle the log belongs to (roundStore.ts): the
// server only ever compares it, which is the same "stores strings, interprets nothing"
// rule the log itself follows.
//
// The SENTENCE paths read NO puzzle store: the log is the player's own working state, not
// a population claim, so an unpublished day needs no guard beyond the shared future-skew
// window — and archive rounds sync like today's (#201), which is what makes a player's
// full history follow them to a new device. Word mode's SUBMIT is the one exception: it
// validates the log against the day's artifact, which only the artifact can answer.

import {
  fold,
  publicIdFromSecret,
  ROUND_GUESS_CAP,
  VOCAB_BUILDS,
  WORD_CLAIM_ZONE,
  WORD_MISS_CAP,
  wordRunFloorMs,
  type WordRanks,
} from '@whippin/shared';
import {
  clientIp,
  LIVE_HEADERS,
  readJsonObject,
  requireDayParams,
  requireSecret,
  requireTurnstileToken,
} from './liveRoute';
import { PUZZLE_TAG_SHAPE, type RoundState, type RoundStore } from './roundStore';
import { wordScoreMaximum, type ScoreMode } from './scoreLimits';
import { errorResponse, json, type FnUrlEvent, type FnUrlResult } from './respond';
import type { PuzzleStore } from './store';
import type { TurnstileVerifier } from './turnstile';

export interface RoundHandlerDeps {
  roundStore: RoundStore;
  // Word mode's round START is Turnstile-gated (#202) — the one write here that mints
  // state for a caller who has done nothing yet.
  turnstile: TurnstileVerifier;
  // Only the direct local HTTP adapter may trust its socket peer (the /scores rule).
  allowSourceIp?: boolean;
}

// The longest log each mode may carry, and therefore the biggest body this route reads.
// SENTENCE: one coalesced flush is bounded by the guess cap itself. WORD: the whole run in
// one write — at most the field's own size in claims plus `WORD_MISS_CAP` misses.
function maxGuesses(mode: ScoreMode): number {
  return mode === 'word' ? WORD_CLAIM_ZONE + WORD_MISS_CAP : ROUND_GUESS_CAP;
}

// …at most that many slugs of at most the longest language's maxSlugLength (#200) plus JSON
// framing (`"…",`), with slack for the secret, the puzzle tag, a Turnstile token and the
// field names. DERIVED rather than hand-picked, so a longer vocabulary cannot silently
// outgrow it — still small, since the point is bounding JSON.parse rather than serving
// uploads.
const LONGEST_SLUG = Math.max(...Object.values(VOCAB_BUILDS).map((build) => build.maxSlugLength));
function bodyMaxBytes(mode: ScoreMode): number {
  return maxGuesses(mode) * (LONGEST_SLUG + 3) + 4_096;
}

export async function handleRound(
  event: FnUrlEvent,
  puzzleStore: PuzzleStore,
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
      'The round route is POST-only: the player key authenticates in the body.',
      responseHeaders,
    );
  }

  // The shared (lang, mode, date) guard triple + future guard (liveRoute.ts).
  const params = requireDayParams(event, serverDate, responseHeaders);
  if (!params.ok) return params.response;
  const { lang, mode, date } = params.value;

  const parsed = readJsonObject(event, 'Round', responseHeaders, bodyMaxBytes(mode));
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const checked = requireSecret(body, responseHeaders);
  if (!checked.ok) return checked.response;
  const publicId = await publicIdFromSecret(checked.value);

  const puzzle = body.puzzle;
  if (typeof puzzle !== 'string' || !PUZZLE_TAG_SHAPE.test(puzzle)) {
    return errorResponse(
      400,
      'bad_request',
      'Body field "puzzle" must be the short tag naming this daily\'s puzzle.',
      responseHeaders,
    );
  }

  const answer = (state: RoundState) => json(200, roundBody(state, instant), responseHeaders);

  // START (word only): the round's clock, stamped from THIS server's clock. Not for cheat
  // prevention — the day's artifact is public and anyone determined can type its words —
  // but because the end-of-run wait check needs an anchor the client cannot move. A
  // client-supplied start is simply backdated and the bound evaporates.
  if (body.turnstileToken !== undefined) {
    if (mode !== 'word') {
      return errorResponse(
        400,
        'bad_request',
        'Only a word round is started: the sentence log streams and needs no clock.',
        responseHeaders,
      );
    }
    if (body.guesses !== undefined) {
      // The two word writes are separate messages and no client sends both. Dispatching on
      // the token and silently DROPPING the guesses would answer 200 to a caller whose log
      // was never stored, which is the one failure this route must never fake.
      return errorResponse(
        400,
        'bad_request',
        'A round is either started or submitted, never both in one call.',
        responseHeaders,
      );
    }
    const token = requireTurnstileToken(body, responseHeaders);
    if (!token.ok) return token.response;
    const remoteIp = clientIp(event, deps.allowSourceIp === true);
    if (!remoteIp) {
      throw new Error('Word round start has no trusted client IP address.');
    }
    // One server-side Siteverify call. A false result is an authentication rejection;
    // transport/service errors throw and follow the handler's operational 500 path.
    if (!(await deps.turnstile.verify(token.value, remoteIp))) {
      return errorResponse(
        403,
        'turnstile_rejected',
        'Turnstile token is invalid.',
        responseHeaders,
      );
    }
    // `running` is not a refusal: the ORIGINAL start stands and is what the answer
    // carries, so a double tap, a retry and a second device all resume the one clock.
    //
    // But WHICH of the two happened is the caller's business, so the answer says it. A
    // client that merely RESUMED someone else's clock cannot know what that run has
    // claimed — Word mode stores nothing until the end — so its own clock runs short and
    // would call a live run finished. Telling it apart from the session that actually
    // stamped the clock is what stops a joiner from writing an empty run over a real one.
    const { outcome, state } = await rounds.start({
      date,
      lang,
      mode,
      publicId,
      puzzle,
      now: instant,
    });
    return json(
      200,
      { ...roundBody(state, instant), resumed: outcome === 'running' },
      responseHeaders,
    );
  }

  const rawGuesses = body.guesses;
  if (rawGuesses === undefined) {
    // READ: the caller's stored round FOR THIS PUZZLE. A 404 is the honest "nothing
    // yet" — a fresh round (or a re-published daily whose old log is retired), local
    // state authoritative until the first write lands. For a word round it is also what
    // makes the daily one-shot ACROSS DEVICES: the answer carries the server's start, so
    // a second device resumes the run instead of beginning a fresh one.
    const state = await rounds.get({ date, lang, mode }, publicId, puzzle);
    if (!state) {
      return errorResponse(404, 'not_found', 'No round recorded.', responseHeaders);
    }
    return answer(state);
  }

  // WRITE: validate before touching the store — a malformed batch is a protocol violation,
  // never a partial write. An EMPTY array is a real word submission (a run that claimed
  // nothing still ends and still counts as played); the sentence stream never sends one.
  const cap = maxGuesses(mode);
  if (
    !Array.isArray(rawGuesses) ||
    (mode !== 'word' && rawGuesses.length === 0) ||
    rawGuesses.length > cap ||
    !rawGuesses.every((g) => typeof g === 'string')
  ) {
    return errorResponse(
      400,
      'bad_request',
      `Body field "guesses" must be an array of at most ${cap} strings.`,
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

  if (mode === 'word') {
    return await submitWordRound(
      { date, lang, mode, publicId, puzzle, guesses },
      puzzleStore,
      rounds,
      instant,
      responseHeaders,
    );
  }

  const { outcome, state } = await rounds.append({
    date,
    lang,
    mode,
    publicId,
    guesses,
    puzzle,
    now: instant,
  });
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
        `[round] round_full: ${date} ${lang} ${mode} ${publicId} refused ` +
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
      instant,
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
      instant,
      // Exposed to script by the CORS headers: a browser can read no response header
      // outside the safelist without it, so an unexposed Retry-After is a value only
      // curl and `backend:dev` ever see.
      { ...responseHeaders, 'Retry-After': '1' },
    );
  }
  return answer(state);
}

interface WordSubmission {
  date: string;
  lang: string;
  mode: ScoreMode;
  publicId: string;
  puzzle: string;
  guesses: string[];
}

// Word mode's ONE end-of-run write (#202). Unlike every other path here it READS THE DAY'S
// ARTIFACT, because the two things it owes the population cannot be answered without one:
// how many of the log's entries are CLAIMS (which is what the wait check is priced from),
// and whether that number is even reachable on this board.
async function submitWordRound(
  input: WordSubmission,
  puzzleStore: PuzzleStore,
  rounds: RoundStore,
  instant: Date,
  headers: Record<string, string>,
): Promise<FnUrlResult> {
  const { date, lang, mode, publicId, puzzle, guesses } = input;
  const artifact = await puzzleStore.getWordPuzzle(date, lang);
  if (!artifact) {
    // A run can only ever have been started on a published artifact, so this is the
    // day-addressed 404 every other route answers for an unpublished daily.
    return errorResponse(404, 'not_found', `No word puzzle for ${date} (${lang}).`, headers, {
      date,
      lang,
    });
  }

  const { claims, misses } = readWordLog(artifact.ranks, guesses);
  // The caps are the CLIENT's too — it truncates its own log to them — but a malicious
  // client will not, so they are enforced here. Claims are bounded by the FIELD rather
  // than by the zone constant: a short artifact holds fewer claimable groups than the zone
  // allows, which is the same ceiling /scores validates a Word score against.
  const claimable = wordScoreMaximum(artifact);
  if (claims > claimable || misses > WORD_MISS_CAP) {
    return errorResponse(
      400,
      'bad_request',
      `A word round holds at most ${claimable} claim(s) and ${WORD_MISS_CAP} miss(es).`,
      headers,
    );
  }

  const { outcome, state } = await rounds.submit({
    date,
    lang,
    mode,
    publicId,
    puzzle,
    guesses,
    // The game's OWN FLOOR, not a tuning knob: Word mode has no early finish, so a run
    // that claimed N groups ran for at least `START_SECONDS + MIN_BONUS * N` seconds
    // (every claim buys at least the COMMON rung). It therefore cannot block honest play,
    // and it needs no retuning as the ladder moves. What it does NOT check is the TIMING
    // of individual guesses — without per-guess arrival stamps there is no way to know
    // 200 claims were not typed over an hour, and the stance is that cheating does not
    // matter (sentence mode is equally unverifiable).
    minElapsedMs: wordRunFloorMs(claims),
    now: instant,
  });

  if (outcome === 'not_started') {
    return refusal(
      409,
      'not_started',
      'No run of this word has been started on this server.',
      state,
      instant,
      headers,
    );
  }
  if (outcome === 'too_early') {
    return refusal(
      409,
      'too_early',
      `A run holding ${claims} claim(s) cannot be over yet.`,
      state,
      instant,
      headers,
    );
  }
  // `already_submitted` is not a refusal but the /scores answer: the daily is one-shot and
  // cannot be replayed, so the FIRST write stands and the caller is told what it says.
  return json(200, roundBody(state, instant), headers);
}

// How a stored log reads against the day's field: how many distinct GROUPS it claimed, and
// how many entries claimed nothing. Distinct RANKS, never raw entries — aliases of one
// group share its rank (#104), which is exactly the identity the client's own dedup uses
// and the count /scores validates. `Object.hasOwn` and not an index read: a folded slug is
// all lowercase letters, so `constructor` is a guess a player can actually type, and a bare
// `ranks[g]` would answer it with a function off the prototype chain.
function readWordLog(ranks: WordRanks, guesses: readonly string[]): {
  claims: number;
  misses: number;
} {
  const claimed = new Set<number>();
  let misses = 0;
  for (const guess of guesses) {
    const entry = Object.hasOwn(ranks, guess) ? ranks[guess] : undefined;
    if (entry && entry.rank >= 1 && entry.rank <= WORD_CLAIM_ZONE) claimed.add(entry.rank);
    else misses += 1;
  }
  return { claims: claimed.size, misses };
}

// What every answer carries: the stored state, plus the server's own clock at the moment it
// answered. `now` is what lets a client anchor a word run's countdown to the server's
// `startedAt` WITHOUT trusting its own device clock — it holds `now - startedAt` (an elapsed
// span both ends agree on) rather than an instant, and the request's own travel time lands
// inside the run rather than outside it, which is what keeps an honest submission clear of
// the wait check.
function roundBody(state: RoundState, instant: Date): Record<string, unknown> {
  return { ...state, now: instant.toISOString() };
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
  instant: Date,
  headers: Record<string, string>,
): FnUrlResult {
  return errorResponse(statusCode, error, message, headers, roundBody(state, instant));
}
