// Shared plumbing of the LIVE routes (/scores, /profile, /friends, /board): the
// no-store header, the JSON-body reader with its size cap, the #187 secret check, and
// the (lang, mode, date) query guard triple the day-addressed reads share. Each of
// these existed as a byte-identical copy per route (four by the time /board landed) —
// one spelling here is what keeps a guard from quietly drifting between routes.

import { dayNumber, isValidSecret } from '@whippin/shared';
import { isValidDate } from './layout';
import { SENTENCE_SCORE_MAX_BY_LANG, type ScoreMode } from './scoreLimits';
import { errorResponse, type FnUrlEvent, type FnUrlResult } from './respond';

export const LIVE_HEADERS = { 'Cache-Control': 'no-store' } as const;

// Every live body is small (a secret, a score, a 19-char avatar); the cap only exists
// so a hostile body cannot make JSON.parse chew megabytes.
export const LIVE_BODY_MAX_BYTES = 4_096;

// The puzzle route's future guard, applied to the day-addressed live reads too.
export const DATE_SKEW_DAYS = 1;

// A guard either yields the validated value or the response to return as-is.
export type Guarded<T> = { ok: true; value: T } | { ok: false; response: FnUrlResult };

const refuse = (response: FnUrlResult): { ok: false; response: FnUrlResult } => ({
  ok: false,
  response,
});

// Parse the request body into a plain JSON object, refusing oversized (413), invalid
// (400) and non-object (400) bodies. `label` names the route in the 413 message.
export function readJsonObject(
  event: FnUrlEvent,
  label: string,
  headers: Record<string, string>,
): Guarded<Record<string, unknown>> {
  let raw: unknown;
  try {
    if (event.body == null) {
      raw = null;
    } else {
      const body = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body;
      if (Buffer.byteLength(body) > LIVE_BODY_MAX_BYTES) {
        return refuse(
          errorResponse(413, 'payload_too_large', `${label} request body is too large.`, headers),
        );
      }
      raw = JSON.parse(body) as unknown;
    }
  } catch {
    return refuse(errorResponse(400, 'bad_request', 'Body must be valid JSON.', headers));
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return refuse(errorResponse(400, 'bad_request', 'Body must be an object.', headers));
  }
  return { ok: true, value: raw as Record<string, unknown> };
}

// Authentication without accounts (#187): possession of the secret is the proof of
// ownership — the caller's identity is DERIVED from it and nothing secret is ever
// stored. A malformed key is no identity at all.
export function requireSecret(
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Guarded<string> {
  if (!isValidSecret(body.secret)) {
    return refuse(
      errorResponse(
        400,
        'bad_request',
        'Body field "secret" must be the 32-hex-character player key.',
        headers,
      ),
    );
  }
  return { ok: true, value: body.secret };
}

export interface DayParams {
  lang: string;
  mode: ScoreMode;
  date: string;
}

// The protocol guards the day-addressed live routes share (/scores, /board): a
// supported language, an explicit mode, a real date no further than one day ahead of
// the server's own active day. `Object.hasOwn` and not an index read — a bare
// `map[lang] === undefined` walks the prototype chain, so `constructor`/`toString`
// would pass as "supported languages" and reach the store key.
export function requireDayParams(
  event: FnUrlEvent,
  serverDate: string,
  headers: Record<string, string>,
): Guarded<DayParams> {
  const lang = event.queryStringParameters?.lang;
  if (!lang || !Object.hasOwn(SENTENCE_SCORE_MAX_BY_LANG, lang)) {
    return refuse(
      errorResponse(
        400,
        'bad_request',
        'Query parameter "lang" must be a supported language ("en" or "fr").',
        headers,
      ),
    );
  }
  const mode = event.queryStringParameters?.mode;
  if (mode !== 'sentence' && mode !== 'word') {
    return refuse(
      errorResponse(
        400,
        'bad_request',
        'Query parameter "mode" is required and must be "sentence" or "word".',
        headers,
      ),
    );
  }
  const date = event.queryStringParameters?.date;
  if (!date || !isValidDate(date)) {
    return refuse(
      errorResponse(
        400,
        'bad_request',
        'Query parameter "date" is required (the game day, "YYYY-MM-DD").',
        headers,
      ),
    );
  }
  if (dayNumber(date) - dayNumber(serverDate) > DATE_SKEW_DAYS) {
    return refuse(
      errorResponse(
        404,
        'not_found',
        `"${date}" is not released yet (active day: ${serverDate}).`,
        headers,
        { date, lang },
      ),
    );
  }
  return { ok: true, value: { lang, mode, date } };
}
