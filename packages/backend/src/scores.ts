import { createHash, createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { dayNumber, type ScoreHistogram } from '@whippin/shared';
import { isValidDate } from './layout';
import {
  SENTENCE_SCORE_MAX_BY_LANG,
  histogramBuckets,
  scoreBucket,
  scoreRanges,
  sentenceScoreMaximum,
  wordScoreMaximum,
  type ScoreMode,
} from './scoreBuckets';
import {
  SCORE_DEDUP_TTL_SECONDS,
  type ScoreKey,
  type ScoreStore,
} from './scoreStore';
import { errorResponse, json, type FnUrlEvent, type FnUrlResult } from './respond';
import type { PuzzleStore } from './store';
import type { TurnstileVerifier } from './turnstile';

const DATE_SKEW_DAYS = 1;
const TURNSTILE_TOKEN_MAX_LENGTH = 2_048;
const SCORE_BODY_MAX_BYTES = 4_096;
const LIVE_HEADERS = { 'Cache-Control': 'no-store' } as const;

export interface ScoreHandlerDeps {
  scoreStore: ScoreStore;
  turnstile: TurnstileVerifier;
  ipHmacSecret: string;
  // Only the direct local HTTP adapter is allowed to trust its socket peer. In Lambda,
  // requestContext.sourceIp is CloudFront's edge, not the viewer.
  allowSourceIp?: boolean;
}

function header(event: FnUrlEvent, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

// CloudFront injects this as viewer-IP + source-port. The generated header is trusted in
// production because the Function URL is IAM-locked to that distribution; a viewer cannot
// call the origin around CloudFront. Local serve supplies requestContext.http.sourceIp.
export function clientIp(event: FnUrlEvent, allowSourceIp = false): string | null {
  const viewer = header(event, 'cloudfront-viewer-address');
  if (viewer) {
    if (viewer.startsWith('[')) {
      const closing = viewer.indexOf(']');
      const candidate = closing > 1 ? viewer.slice(1, closing) : '';
      if (isIP(candidate)) return candidate;
    }
    if (isIP(viewer)) return viewer;
    const colon = viewer.lastIndexOf(':');
    const candidate = colon > 0 ? viewer.slice(0, colon) : '';
    if (isIP(candidate)) return candidate;
  }

  if (!allowSourceIp) return null;
  const source = event.requestContext?.http?.sourceIp;
  return source && isIP(source) ? source : null;
}

export function hashClientIp(ip: string, secret: string): string {
  return createHmac('sha256', secret).update(ip).digest('hex');
}

function bodyOf(event: FnUrlEvent): unknown {
  if (event.body == null) return null;
  const body = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  if (Buffer.byteLength(body) > SCORE_BODY_MAX_BYTES) throw new Error('request_too_large');
  return JSON.parse(body) as unknown;
}

function histogram(
  mode: ScoreMode,
  stored: { buckets: readonly number[]; total: number },
  bucket: number | null,
): ScoreHistogram {
  return { buckets: histogramBuckets(mode, stored.buckets), total: stored.total, bucket };
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

  const lang = event.queryStringParameters?.lang;
  if (!lang || SENTENCE_SCORE_MAX_BY_LANG[lang] === undefined) {
    return errorResponse(
      400,
      'bad_request',
      'Query parameter "lang" must be a supported language ("en" or "fr").',
      responseHeaders,
    );
  }

  const mode = event.queryStringParameters?.mode;
  if (mode !== 'sentence' && mode !== 'word') {
    return errorResponse(
      400,
      'bad_request',
      'Query parameter "mode" is required and must be "sentence" or "word".',
      responseHeaders,
    );
  }

  const date = event.queryStringParameters?.date;
  if (!date || !isValidDate(date)) {
    return errorResponse(
      400,
      'bad_request',
      'Query parameter "date" is required (the game day, "YYYY-MM-DD").',
      responseHeaders,
    );
  }
  if (dayNumber(date) - dayNumber(serverDate) > DATE_SKEW_DAYS) {
    return errorResponse(
      404,
      'not_found',
      `"${date}" is not released yet (active day: ${serverDate}).`,
      responseHeaders,
      { date, lang },
    );
  }

  const key: ScoreKey = { date, lang, mode };
  let score: number | undefined;
  let turnstileToken: string | undefined;
  let remoteIp: string | null = null;

  if (method === 'POST') {
    let raw: unknown;
    try {
      raw = bodyOf(event);
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === 'request_too_large';
      return errorResponse(
        tooLarge ? 413 : 400,
        tooLarge ? 'payload_too_large' : 'bad_request',
        tooLarge ? 'Score request body is too large.' : 'Body must be valid JSON.',
        responseHeaders,
      );
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return errorResponse(400, 'bad_request', 'Body must be an object.', responseHeaders);
    }
    const body = raw as Record<string, unknown>;
    if (typeof body.score !== 'number' || !Number.isInteger(body.score)) {
      return errorResponse(400, 'bad_request', 'Body field "score" must be an integer.', responseHeaders);
    }
    score = body.score;
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

  const ranges = scoreRanges(mode);
  if (method === 'GET') {
    const stored = await deps.scoreStore.get(key, ranges.length);
    return json(200, histogram(mode, stored, null), responseHeaders);
  }

  // POST-only values were established above.
  const submittedScore = score!;
  const maximum =
    mode === 'word'
      ? wordScoreMaximum(wordPuzzle!)
      : sentenceScoreMaximum(lang, sentencePuzzle!);
  const bucket = scoreBucket(mode, submittedScore);
  const minimum = mode === 'word' ? 0 : 1;
  if (maximum == null || bucket == null || submittedScore < minimum || submittedScore > maximum) {
    return errorResponse(
      400,
      'invalid_score',
      `Score must be an integer from ${minimum} to ${maximum ?? 0} for this daily.`,
      responseHeaders,
    );
  }

  const ipHash = hashClientIp(remoteIp!, deps.ipHmacSecret);
  const accepted = await deps.scoreStore.increment({
    ...key,
    ipHash,
    bucket,
    bucketCount: ranges.length,
    expiresAt: Math.floor(instant.getTime() / 1000) + SCORE_DEDUP_TTL_SECONDS,
    // DynamoDB ClientRequestToken permits 1–36 characters. This stores neither the
    // Turnstile token nor another user-linked value.
    requestToken: createHash('sha256').update(turnstileToken!).digest('hex').slice(0, 36),
  });
  if (!accepted) {
    return errorResponse(
      429,
      'submission_limit',
      'Score submission limit reached.',
      { ...responseHeaders, 'Retry-After': String(SCORE_DEDUP_TTL_SECONDS) },
    );
  }

  // Strongly consistent in DynamoDB: this caller's committed increment is guaranteed to
  // be present (and concurrent increments may already be present too).
  const stored = await deps.scoreStore.get(key, ranges.length);
  return json(200, histogram(mode, stored, bucket), responseHeaders);
}
