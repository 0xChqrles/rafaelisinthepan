import { createHash, createHmac, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { VIEWER_IP_HEADER, publicIdFromSecret, type ScoreHistogram } from '@whippin/shared';
import { LIVE_HEADERS, readJsonObject, requireDayParams, requireSecret } from './liveRoute';
import { sentenceScoreMaximum, wordScoreMaximum } from './scoreLimits';
import {
  SCORE_DEDUP_TTL_SECONDS,
  type ScoreKey,
  type ScoreRow,
  type ScoreStore,
} from './scoreStore';
import { errorResponse, json, type FnUrlEvent, type FnUrlResult } from './respond';
import type { PuzzleStore } from './store';
import type { TurnstileVerifier } from './turnstile';

const TURNSTILE_TOKEN_MAX_LENGTH = 2_048;

export interface ScoreHandlerDeps {
  scoreStore: ScoreStore;
  turnstile: TurnstileVerifier;
  ipHmacSecret: string;
  // Only the direct local HTTP adapter is allowed to trust its socket peer. In Lambda,
  // requestContext.sourceIp is CloudFront's edge, not the viewer.
  allowSourceIp?: boolean;
  // Are the verifier's tokens SINGLE-USE? A real Turnstile token is, which is what makes
  // its hash a perfect idempotency key (see the submission below). The LOCAL accept-all
  // verifier's are not — Cloudflare's always-passing test site key hands the browser the
  // same dummy token on every challenge — so hashing it collapses every local submission
  // of the day onto ONE key: the first is recorded and every later one is waved through
  // as a replay. Local serve sets this false and gets a fresh idempotency token per
  // request instead.
  singleUseTokens?: boolean;
}

function header(event: FnUrlEvent, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

// The CDN's viewer-request function stamps CloudFront's own read of the TCP peer into
// VIEWER_IP_HEADER, overwriting whatever the viewer sent under that name. It is trusted in
// production because the Function URL is IAM-locked to that distribution, so a viewer
// cannot reach this origin around CloudFront and hand it a header of their own; a
// viewer-supplied X-Forwarded-For chain is deliberately read by nothing here. Local serve
// has no CDN and supplies requestContext.http.sourceIp instead.
export function clientIp(event: FnUrlEvent, allowSourceIp = false): string | null {
  const viewer = header(event, VIEWER_IP_HEADER);
  if (viewer && isIP(viewer)) return viewer;

  if (!allowSourceIp) return null;
  const source = event.requestContext?.http?.sourceIp;
  return source && isIP(source) ? source : null;
}

export function hashClientIp(ip: string, secret: string): string {
  return createHmac('sha256', secret).update(ip).digest('hex');
}

// The histogram is DERIVED from the day's per-player rows at read time (#187): one bucket
// per distinct recorded score, ascending, each an exact inclusive range. The rows are a
// strict superset of the retired bucket counters, so the response shape the solved screen
// consumes (#170/#176/#180) is unchanged — only the numbers' origin moved. `own` locates
// the caller's recorded score on POST; GET passes null (a revisiting client already knows
// its persisted score and locates it in the ranges itself).
export function derivedHistogram(rows: readonly ScoreRow[], own: number | null): ScoreHistogram {
  const counts = new Map<number, number>();
  for (const row of rows) counts.set(row.score, (counts.get(row.score) ?? 0) + 1);
  const scores = [...counts.keys()].sort((a, b) => a - b);
  const buckets = scores.map((score) => ({
    min: score,
    max: score,
    count: counts.get(score)!,
  }));
  const index = own == null ? -1 : scores.indexOf(own);
  return { buckets, total: rows.length, bucket: index < 0 ? null : index };
}

export async function handleScores(
  event: FnUrlEvent,
  puzzleStore: PuzzleStore,
  deps: ScoreHandlerDeps,
  serverDate: string,
  instant: Date,
  cors: Record<string, string>,
): Promise<FnUrlResult> {
  const responseHeaders = { ...cors, ...LIVE_HEADERS };
  const method = event.requestContext?.http?.method ?? 'GET';

  // The shared (lang, mode, date) guard triple + future guard (liveRoute.ts).
  const params = requireDayParams(event, serverDate, responseHeaders);
  if (!params.ok) return params.response;
  const { lang, mode, date } = params.value;

  const key: ScoreKey = { date, lang, mode };
  let score: number | undefined;
  let secret: string | undefined;
  let turnstileToken: string | undefined;
  let remoteIp: string | null = null;

  if (method === 'POST') {
    const parsed = readJsonObject(event, 'Score', responseHeaders);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    if (typeof body.score !== 'number' || !Number.isInteger(body.score)) {
      return errorResponse(400, 'bad_request', 'Body field "score" must be an integer.', responseHeaders);
    }
    score = body.score;
    // Authentication without accounts (#187): the server DERIVES the public identity
    // from the secret below and stores nothing secret.
    const checked = requireSecret(body, responseHeaders);
    if (!checked.ok) return checked.response;
    secret = checked.value;
    if (
      typeof body.turnstileToken !== 'string' ||
      body.turnstileToken.length === 0 ||
      body.turnstileToken.length > TURNSTILE_TOKEN_MAX_LENGTH
    ) {
      return errorResponse(403, 'turnstile_rejected', 'Turnstile token is missing or invalid.', responseHeaders);
    }
    turnstileToken = body.turnstileToken;
    remoteIp = clientIp(event, deps.allowSourceIp === true);
    if (!remoteIp) {
      throw new Error('Score submission has no trusted client IP address.');
    }

    // One server-side Siteverify call. A false result is an authentication rejection;
    // transport/service errors throw and follow the handler's operational 500 path.
    if (!(await deps.turnstile.verify(turnstileToken, remoteIp))) {
      return errorResponse(403, 'turnstile_rejected', 'Turnstile token is invalid.', responseHeaders);
    }
  }

  // A score population exists only for a published daily. POST also needs the artifact to
  // derive the mode's real ceiling (especially a short Word map).
  const wordPuzzle = mode === 'word' ? await puzzleStore.getWordPuzzle(date, lang) : null;
  const sentencePuzzle = mode === 'sentence' ? await puzzleStore.getPuzzle(date, lang) : null;
  const puzzle = wordPuzzle ?? sentencePuzzle;
  if (puzzle == null) {
    return errorResponse(
      404,
      'not_found',
      `No ${mode === 'word' ? 'word puzzle' : 'puzzle'} for ${date} (${lang}).`,
      responseHeaders,
      { date, lang },
    );
  }

  if (method === 'GET') {
    const rows = await deps.scoreStore.list(key);
    return json(200, derivedHistogram(rows, null), responseHeaders);
  }

  // POST-only values were established above.
  const submittedScore = score!;
  const maximum =
    mode === 'word'
      ? wordScoreMaximum(wordPuzzle!)
      : sentenceScoreMaximum(lang, sentencePuzzle!);
  const minimum = mode === 'word' ? 0 : 1;
  if (maximum == null || submittedScore < minimum || submittedScore > maximum) {
    return errorResponse(
      400,
      'invalid_score',
      `Score must be an integer from ${minimum} to ${maximum ?? 0} for this daily.`,
      responseHeaders,
    );
  }

  const publicId = await publicIdFromSecret(secret!);
  const ipHash = hashClientIp(remoteIp!, deps.ipHmacSecret);
  const outcome = await deps.scoreStore.submit({
    ...key,
    publicId,
    score: submittedScore,
    submittedAt: instant.toISOString(),
    ipHash,
    expiresAt: Math.floor(instant.getTime() / 1000) + SCORE_DEDUP_TTL_SECONDS,
    // DynamoDB ClientRequestToken permits 1–36 characters. This stores neither the
    // Turnstile token nor another user-linked value. Hashing the token is what makes a
    // retry of ONE submission idempotent — sound exactly because a real token is
    // single-use; where it is not (see `singleUseTokens`), a fresh id per request is the
    // honest key, since two submissions carrying the same dummy token are two submissions.
    requestToken:
      deps.singleUseTokens === false
        ? randomUUID()
        : createHash('sha256').update(turnstileToken!).digest('hex').slice(0, 36),
  });
  if (outcome === 'capped') {
    return errorResponse(
      429,
      'submission_limit',
      'Score submission limit reached.',
      { ...responseHeaders, 'Retry-After': String(SCORE_DEDUP_TTL_SECONDS) },
    );
  }

  // Strongly consistent: this caller's committed row is guaranteed present (and
  // concurrent submissions may already be too). On `already_recorded` the FIRST write
  // won, so the honest bucket is the STORED row's score — never the resubmission's,
  // which changed nothing.
  const rows = await deps.scoreStore.list(key);
  const own =
    outcome === 'recorded'
      ? submittedScore
      : rows.find((row) => row.publicId === publicId)?.score ?? null;
  return json(200, derivedHistogram(rows, own), responseHeaders);
}
