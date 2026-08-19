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

import { decodeAvatar, isValidSecret, publicIdFromSecret, PUBLIC_ID_PATTERN } from '@whippin/shared';
import { containsSwastika } from './avatarModeration';
import { isNameAllowed } from './nameFilter';
import type { ProfileStore } from './profileStore';
import { errorResponse, json, type FnUrlEvent, type FnUrlResult } from './respond';

export const NAME_MAX_LENGTH = 16;
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

// The display name's shape rule: at most 16 code points after trimming, no control or
// format characters (a zero-width or bidi character in a name is only ever a disguise).
// Empty is allowed — the avatar alone is a valid profile.
export function validateName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if ([...name].length > NAME_MAX_LENGTH) return null;
  if (/[\p{Cc}\p{Cf}]/u.test(name)) return null;
  return name;
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
      `Body field "name" must be a string of at most ${NAME_MAX_LENGTH} characters.`,
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
