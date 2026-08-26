// The #188 player-profile route on the ONE handler: GET|POST /profile.
//
//   GET  /profile?id=<publicId>          — the public profile (name + avatar): what a
//                                          board renders, and what a freshly linked
//                                          device loads. 404 when never customized.
//   POST /profile { token, name, avatar[, createOnly:true] }
//                                        — authenticated write, keyed by the ACCOUNT the
//                                          caller's device token resolves to (#216; it was
//                                          a publicId derived from a shared secret until
//                                          then). Ordinary writes upsert; `createOnly`
//                                          atomically refuses to replace an existing row.
//                                          A separate write path from scores.
//
// Moderation happens here, on write: the banned-strings name filter and the avatar's
// best-effort swastika check — both reject with a named 400.
//
// Like /scores, the `id` query parameter is only half the change: it must also be in
// the CloudFront profile behavior's allowList (root AGENTS.md contract), and a
// production POST must carry `x-amz-content-sha256` over the exact body bytes (OAC).

import { decodeAvatar, isValidName, NAME_MAX_LENGTH, PUBLIC_ID_PATTERN } from '@whippin/shared';
import { containsSwastika } from './avatarModeration';
import type { DeviceStore } from './deviceStore';
import { LIVE_HEADERS, readJsonObject, requireDevice } from './liveRoute';
import { isNameAllowed } from './nameFilter';
import type { ProfileStore } from './profileStore';
import { errorResponse, json, type FnUrlEvent, type FnUrlResult } from './respond';

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
  devices: DeviceStore,
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
    const found = await profiles.get(id);
    // GONE is not the same answer as NEVER CUSTOMIZED (#204). A 404 here means "no row
    // yet", and every caller dresses that with the ASSIGNED pseudonym and mark derived from
    // the id — which is still this player's face. An account an email link DELETED has no
    // face to fall back to, so it is a distinct 410 the client can act on: an invite landing
    // says the link expired, and the signed-out screen stops naming an account that is gone.
    if (!found.live) {
      return errorResponse(410, 'account_gone', `Player "${id}" no longer exists.`, responseHeaders);
    }
    if (found.profile == null) {
      return errorResponse(404, 'not_found', `No profile for "${id}".`, responseHeaders);
    }
    return json(200, found.profile, responseHeaders);
  }

  const parsed = readJsonObject(event, 'Profile', responseHeaders);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  if (body.createOnly !== undefined && body.createOnly !== true) {
    return errorResponse(
      400,
      'bad_request',
      'Body field "createOnly" must be true when present.',
      responseHeaders,
    );
  }

  // Authentication (#216): the caller's device token resolves to the ACCOUNT this row
  // belongs to, so the only profile a caller can write is their own — and a signed-out
  // device is told so rather than writing under a stale identity.
  const auth = await requireDevice(body, responseHeaders, devices, instant);
  if (!auth.ok) return auth.response;

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
  // The EMPTY avatar is "no custom mark" (PR-219 round-2 review): the editor stores ''
  // when the drawing is still the ASSIGNED mark it opened on — the name rule's own shape,
  // display-only in both directions — so every surface keeps DERIVING the face from the
  // account id instead of freezing a generated grid into the row. Nothing to decode and
  // nothing to moderate; the board and preview readers already dress '' as null.
  if (body.avatar !== '') {
    let cells: number[];
    try {
      cells = decodeAvatar(body.avatar).cells;
    } catch {
      return errorResponse(400, 'bad_request', 'Body field "avatar" is not a valid avatar.', responseHeaders);
    }
    if (containsSwastika(cells)) {
      return errorResponse(400, 'avatar_rejected', 'This avatar is not allowed.', responseHeaders);
    }
  }

  const publicId = auth.value.account.accountId;
  const input = {
    publicId,
    name,
    avatar: body.avatar,
    now: instant.toISOString(),
  };
  if (body.createOnly === true) {
    const created = await profiles.create(input);
    if (!created) {
      return errorResponse(
        409,
        'profile_exists',
        'A profile already exists for this account.',
        responseHeaders,
      );
    }
  } else {
    await profiles.upsert(input);
  }
  return json(200, { publicId, name, avatar: body.avatar }, responseHeaders);
}
