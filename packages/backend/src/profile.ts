// The #188 player-profile route on the ONE handler: GET|POST /profile.
//
//   GET  /profile?id=<publicId>          — the public profile (name + avatar): what a
//                                          board renders, and what a freshly linked
//                                          device loads. 404 when never customized.
//   POST /profile { secret, name, avatar } — authenticated upsert, keyed by the
//                                          publicId DERIVED from the secret (#187).
//                                          A separate write path from scores.
//
// Moderation happens here, on write: the banned-strings name filter and the avatar's
// best-effort swastika check — both reject with a named 400.
//
// Like /scores, the `id` query parameter is only half the change: it must also be in
// the CloudFront profile behavior's allowList (root AGENTS.md contract), and a
// production POST must carry `x-amz-content-sha256` over the exact body bytes (OAC).

import {
  decodeAvatar,
  isValidName,
  isValidSecret,
  publicIdFromSecret,
  NAME_MAX_LENGTH,
  PUBLIC_ID_PATTERN,
} from '@whippin/shared';
import { containsSwastika } from './avatarModeration';
import { isNameAllowed } from './nameFilter';
import type { ProfileStore } from './profileStore';
import { errorResponse, json, type FnUrlEvent, type FnUrlResult } from './respond';

const PROFILE_BODY_MAX_BYTES = 4_096;
const LIVE_HEADERS = { 'Cache-Control': 'no-store' } as const;

function bodyOf(event: FnUrlEvent): unknown {
  if (event.body == null) return null;
  const body = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  if (Buffer.byteLength(body) > PROFILE_BODY_MAX_BYTES) throw new Error('request_too_large');
  return JSON.parse(body) as unknown;
}

// The display name's shape rule is the SHARED one (user-decided 2026-08-19: "the server
// should apply the same rules") — alphanumerics and underscores, case kept, at most
// NAME_MAX_LENGTH characters — so the store can only ever hold what the editor can
// produce. The old local rule (trim, then a code-point cap and a control/format-character
// check) is subsumed: whitespace, punctuation, accents, emoji and zero-width characters
// are all things `sanitizeName` would change, so `isValidName` refuses them here. Empty
// stays allowed — the avatar alone is a valid profile.
//
// It REFUSES rather than sanitizes: sanitizing server-side would silently store a name
// nobody typed, and the web sends a sanitized name through every path it has, so a
// non-conforming body is a caller that went around the editor.
export function validateName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return isValidName(raw) ? raw : null;
}

export async function handleProfile(
  event: FnUrlEvent,
  profiles: ProfileStore,
  instant: Date,
  cors: Record<string, string>,
): Promise<FnUrlResult> {
  const responseHeaders = { ...cors, ...LIVE_HEADERS };
  const method = event.requestContext?.http?.method ?? 'GET';

  if (method === 'GET') {
    const id = event.queryStringParameters?.id;
    if (!id || !PUBLIC_ID_PATTERN.test(id)) {
      return errorResponse(
        400,
        'bad_request',
        'Query parameter "id" must be a 16-character player id.',
        responseHeaders,
      );
    }
    const profile = await profiles.get(id);
    if (profile == null) {
      return errorResponse(404, 'not_found', `No profile for "${id}".`, responseHeaders);
    }
    return json(200, profile, responseHeaders);
  }

  let raw: unknown;
  try {
    raw = bodyOf(event);
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === 'request_too_large';
    return errorResponse(
      tooLarge ? 413 : 400,
      tooLarge ? 'payload_too_large' : 'bad_request',
      tooLarge ? 'Profile request body is too large.' : 'Body must be valid JSON.',
      responseHeaders,
    );
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return errorResponse(400, 'bad_request', 'Body must be an object.', responseHeaders);
  }
  const body = raw as Record<string, unknown>;

  // Authentication without accounts (#187): possession of the secret is the proof of
  // ownership — the row is keyed by the identity DERIVED from it, and nothing secret is
  // ever stored. A malformed key is no identity at all.
  if (!isValidSecret(body.secret)) {
    return errorResponse(
      400,
      'bad_request',
      'Body field "secret" must be the 32-hex-character player key.',
      responseHeaders,
    );
  }

  const name = validateName(body.name);
  if (name === null) {
    return errorResponse(
      400,
      'bad_request',
      `Body field "name" must be at most ${NAME_MAX_LENGTH} letters, digits and underscores.`,
      responseHeaders,
    );
  }
  if (!isNameAllowed(name)) {
    return errorResponse(400, 'name_rejected', 'This name is not allowed.', responseHeaders);
  }

  if (typeof body.avatar !== 'string') {
    return errorResponse(400, 'bad_request', 'Body field "avatar" must be a string.', responseHeaders);
  }
  let cells: number[];
  try {
    cells = decodeAvatar(body.avatar).cells;
  } catch {
    return errorResponse(400, 'bad_request', 'Body field "avatar" is not a valid avatar.', responseHeaders);
  }
  if (containsSwastika(cells)) {
    return errorResponse(400, 'avatar_rejected', 'This avatar is not allowed.', responseHeaders);
  }

  const publicId = await publicIdFromSecret(body.secret);
  await profiles.upsert({
    publicId,
    name,
    avatar: body.avatar,
    now: instant.toISOString(),
  });
  return json(200, { publicId, name, avatar: body.avatar }, responseHeaders);
}
