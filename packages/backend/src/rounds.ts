// The #201 round route on the ONE handler: POST /round?lang=&date=&mode=.
//
//   { secret }                 — your stored round for that daily (404 = none yet);
//   { secret, guesses: [...] } — append to its ordered guess log.
//
// Every call answers with the FULL stored state `{ guesses, createdAt }`, so a write is
// also a reconciliation: the caller computes against stale local state, the server
// appends to the true log and answers with truth, and the tab re-renders correct. The
// route is POST-only for the /friends reason — the secret is the auth (#187) and it
// travels in the BODY, never in a query string, so there is no way to ask without
// proving who you are. Its CloudFront behavior forwards exactly the three addressing
// queries (the root AGENTS.md allowList contract); a production POST still needs
// `x-amz-content-sha256` over the exact body bytes (OAC).
//
// Unlike /scores, this route reads NO puzzle store: the log is the player's own working
// state, not a population claim, so an unpublished day needs no guard beyond the shared
// future-skew window — and archive rounds sync like today's (#201), which is what makes
// a player's full history follow them to a new device.

import { publicIdFromSecret, ROUND_GUESS_CAP, VOCAB_BUILDS } from '@whippin/shared';
import { LIVE_HEADERS, readJsonObject, requireDayParams, requireSecret } from './liveRoute';
import { errorResponse, json, type FnUrlEvent, type FnUrlResult } from './respond';
import type { RoundStore } from './roundStore';

// A coalesced flush is bounded by the cap itself: at most ROUND_GUESS_CAP slugs of at
// most the language's maxSlugLength (#200) plus JSON framing — tens of KB worst case,
// far under any parse concern but well over the default live-body cap.
const ROUND_BODY_MAX_BYTES = 32_768;

// What a guess IS on the wire: a folded slug — fold() keeps only [a-z] and dashes,
// collapses repeats and trims the edges — so anything else was never typed into the
// game. Length is bounded by the language's own vocabulary record (#200).
const SLUG_SHAPE = /^[a-z]+(-[a-z]+)*$/;

export async function handleRound(
  event: FnUrlEvent,
  rounds: RoundStore,
  serverDate: string,
  instant: Date,
  cors: Record<string, string>,
): Promise<FnUrlResult> {
  const responseHeaders = { ...cors, ...LIVE_HEADERS };
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

  const parsed = readJsonObject(event, 'Round', responseHeaders, ROUND_BODY_MAX_BYTES);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const checked = requireSecret(body, responseHeaders);
  if (!checked.ok) return checked.response;
  const publicId = await publicIdFromSecret(checked.value);

  const rawGuesses = body.guesses;
  if (rawGuesses === undefined) {
    // READ: the caller's stored round. A 404 is the honest "nothing yet" — a fresh
    // round, local state authoritative until the first write lands.
    const state = await rounds.get({ date, lang, mode }, publicId);
    if (!state) {
      return errorResponse(404, 'not_found', 'No round recorded.', responseHeaders);
    }
    return json(200, state, responseHeaders);
  }

  // APPEND: validate before touching the store — a malformed batch is a protocol
  // violation, never a partial write.
  if (
    !Array.isArray(rawGuesses) ||
    rawGuesses.length === 0 ||
    rawGuesses.length > ROUND_GUESS_CAP ||
    !rawGuesses.every((g) => typeof g === 'string')
  ) {
    return errorResponse(
      400,
      'bad_request',
      `Body field "guesses" must be a non-empty array of at most ${ROUND_GUESS_CAP} strings.`,
      responseHeaders,
    );
  }
  const maxLength = VOCAB_BUILDS[lang].maxSlugLength;
  const guesses = rawGuesses as string[];
  if (!guesses.every((g) => g.length <= maxLength && SLUG_SHAPE.test(g))) {
    return errorResponse(
      400,
      'bad_request',
      `Every guess must be a folded slug of at most ${maxLength} characters.`,
      responseHeaders,
    );
  }

  const { outcome, state } = await rounds.append({
    date,
    lang,
    mode,
    publicId,
    guesses,
    now: instant,
  });
  if (outcome === 'round_full') {
    // Counted where it can be reviewed (#201): a real player reaching the cap means an
    // unreachable secret — puzzle-curation signal available no other way. The client
    // stops after the first refusal, so each hit is one honest line, not spam.
    console.warn(
      `[round] round_full: ${date} ${lang} ${mode} ${publicId} refused ` +
        `${guesses.length} further guess(es) past the ${ROUND_GUESS_CAP}-guess cap.`,
    );
    return errorResponse(
      409,
      'round_full',
      `This round already holds the maximum of ${ROUND_GUESS_CAP} guesses.`,
      responseHeaders,
    );
  }
  if (outcome === 'too_fast') {
    return errorResponse(
      429,
      'too_fast',
      'Guess writes are limited to about one per second per player.',
      { ...responseHeaders, 'Retry-After': '1' },
    );
  }
  return json(200, state, responseHeaders);
}
