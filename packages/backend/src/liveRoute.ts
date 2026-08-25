// Shared plumbing of the LIVE routes (/scores, /profile, /friends, /board, /round): the
// no-store header, the JSON-body reader with its size cap, the #216 device-token
// authentication (`requireDevice`, which replaced the #187 secret check), the Turnstile
// token check the gated writes share, and the (lang, mode, date) query guard
// triple the day-addressed reads share. Each of these existed as a byte-identical copy
// per route (four by the time /board landed) — one spelling here is what keeps a guard
// from quietly drifting between routes.

import { isIP } from 'node:net';
import { dayNumber, isValidDeviceToken, VIEWER_IP_HEADER, VOCAB_BUILDS } from '@whippin/shared';
import { isValidDate } from './layout';
import {
  deviceTokenHash,
  staleLastSeen,
  type DeviceStore,
  type ResolvedDevice,
} from './deviceStore';
import type { ScoreMode } from './scoreLimits';
import { errorResponse, type FnUrlEvent, type FnUrlResult } from './respond';

export const LIVE_HEADERS = { 'Cache-Control': 'no-store' } as const;

// Every live body is small (a secret, a score, a 19-char avatar); the default cap only
// exists so a hostile body cannot make JSON.parse chew megabytes.
export const LIVE_BODY_MAX_BYTES = 4_096;

// The puzzle route's future guard, applied to the day-addressed live reads too.
export const DATE_SKEW_DAYS = 1;

// What the 400 tells the caller, spelled from the record the check reads rather than
// restated — the drift this file's own guard exists to remove.
const SUPPORTED_LANGS = Object.keys(VOCAB_BUILDS)
  .map((lang) => `"${lang}"`)
  .join(', ');

// A guard either yields the validated value or the response to return as-is.
export type Guarded<T> = { ok: true; value: T } | { ok: false; response: FnUrlResult };

const refuse = (response: FnUrlResult): { ok: false; response: FnUrlResult } => ({
  ok: false,
  response,
});

// Parse the request body into a plain JSON object, refusing oversized (413), invalid
// (400) and non-object (400) bodies. `label` names the route in the 413 message. The cap
// defaults to LIVE_BODY_MAX_BYTES; a route whose legitimate bodies run larger passes its
// own bound (still small — the point is bounding JSON.parse, not serving uploads).
export function readJsonObject(
  event: FnUrlEvent,
  label: string,
  headers: Record<string, string>,
  maxBytes: number = LIVE_BODY_MAX_BYTES,
): Guarded<Record<string, unknown>> {
  let raw: unknown;
  try {
    if (event.body == null) {
      raw = null;
    } else {
      const body = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body;
      if (Buffer.byteLength(body) > maxBytes) {
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

// The device token's SHAPE (#216) — checked before anything is hashed, logged or read, and
// checked against the CANONICAL spelling only: an uppercase or short value is refused, never
// normalized, so one token can only ever key one row.
//
// A malformed token is an INPUT ERROR (400), which is deliberately not `unknown_device`
// (401). The two say different things and the client acts on them differently: one is a
// caller that went around the app, the other is the answer that signs a player out.
export function requireDeviceToken(
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Guarded<string> {
  if (!isValidDeviceToken(body.token)) {
    return refuse(
      errorResponse(
        400,
        'bad_request',
        'Body field "token" must be the 64-hex-character device token.',
        headers,
      ),
    );
  }
  return { ok: true, value: body.token };
}

// Authentication (#216): the token resolves to a DEVICE, and the device to the account it
// acts as. A well-formed token with no device item — or whose account is gone — is
// `unknown_device`: the distinct, unambiguous answer the client turns into its signed-out
// screen. It is NEVER what an ordinary authenticated request uses to mint a fresh identity;
// only the explicit bootstrap does that, and only with a Turnstile proof.
//
// `lastSeenAt` moves at most once a DAY per device (see `staleLastSeen`) — this rides every
// authenticated call, including the round route's once-a-second appends.
export async function requireDevice(
  body: Record<string, unknown>,
  headers: Record<string, string>,
  devices: DeviceStore,
  instant: Date,
): Promise<Guarded<ResolvedDevice>> {
  const token = requireDeviceToken(body, headers);
  if (!token.ok) return token;
  const tokenHash = deviceTokenHash(token.value);
  const resolved = await devices.resolve(tokenHash);
  if (!resolved) {
    return refuse(
      errorResponse(
        401,
        'unknown_device',
        'This device is signed out.',
        headers,
      ),
    );
  }
  const now = instant.toISOString();
  if (staleLastSeen(resolved.device.lastSeenAt, now)) {
    await devices.touch(tokenHash, now);
  }
  return { ok: true, value: resolved };
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
//
// It lives HERE, with the other live plumbing, because the Turnstile-gated writes both need
// it: /scores hashes it for the IP dedup, and #202's word round start hands it to
// Siteverify. A second route reaching into /scores for it would make that file a utility
// module for routes it knows nothing about.
export function clientIp(event: FnUrlEvent, allowSourceIp = false): string | null {
  const viewer = header(event, VIEWER_IP_HEADER);
  if (viewer && isIP(viewer)) return viewer;

  if (!allowSourceIp) return null;
  const source = event.requestContext?.http?.sourceIp;
  return source && isIP(source) ? source : null;
}

// Cloudflare tokens run well under this; the bound only exists so a hostile body cannot
// hand Siteverify a megabyte.
export const TURNSTILE_TOKEN_MAX_LENGTH = 2_048;

// The Turnstile-gated writes' shared token check (/scores' submission, #202's word round
// start). A missing or implausible token is refused as the authentication failure it is,
// before any network call is made.
export function requireTurnstileToken(
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Guarded<string> {
  const token = body.turnstileToken;
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > TURNSTILE_TOKEN_MAX_LENGTH
  ) {
    return refuse(
      errorResponse(403, 'turnstile_rejected', 'Turnstile token is missing or invalid.', headers),
    );
  }
  return { ok: true, value: token };
}

export interface GameParams {
  lang: string;
  mode: ScoreMode;
}

export interface DayParams extends GameParams {
  date: string;
}

// WHICH GAME a live route is being asked about: a supported language and an explicit mode.
// A supported language is one the pipeline has built a vocabulary for (#200's generated
// metadata), which is the same set the score ceiling is read from. `Object.hasOwn` and not
// an index read — a bare `map[lang] === undefined` walks the prototype chain, so
// `constructor`/`toString` would pass as "supported languages" and reach the store key.
//
// Split out from the day-addressed triple below with #211: the private history read is
// addressed by a MONTH rather than a day, so it needs these two and not the third.
export function requireGameParams(
  event: FnUrlEvent,
  headers: Record<string, string>,
): Guarded<GameParams> {
  const lang = event.queryStringParameters?.lang;
  if (!lang || !Object.hasOwn(VOCAB_BUILDS, lang)) {
    return refuse(
      errorResponse(
        400,
        'bad_request',
        // Named from the SAME record the check reads. A hardcoded list is the one
        // operator-visible signal of exactly the drift this record exists to remove:
        // it would keep offering "en" or "fr" after the pipeline built a third
        // language, and keep claiming a language is supported after one was dropped.
        `Query parameter "lang" must be a supported language (${SUPPORTED_LANGS}).`,
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
  return { ok: true, value: { lang, mode } };
}

// The protocol guards the day-addressed live routes share (/scores, /board, /round): which
// game, plus a real date no further than one day ahead of the server's own active day.
export function requireDayParams(
  event: FnUrlEvent,
  serverDate: string,
  headers: Record<string, string>,
): Guarded<DayParams> {
  const game = requireGameParams(event, headers);
  if (!game.ok) return game;
  const { lang, mode } = game.value;
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
