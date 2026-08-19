// The #189 friends route on the ONE handler: POST /friends.
//
//   { secret }                    — your list (the trusted board's population, #190);
//   { secret, add: "<publicId>" } — the MUTUAL edge an invite link's click records;
//   { secret, remove: "<id>" }    — the symmetric removal.
//
// Every call answers with the caller's current list, so a client never has to guess what a
// write did — and every call is a POST for one reason: the secret is the auth (#187) and it
// travels in the BODY, never in a query string. That is also why the read is a POST: the
// server resolves YOUR edges, and there is no way to ask for them without proving who you
// are. The route reads no query parameter at all, which is what its CloudFront behavior's
// empty query allow-list says (root AGENTS.md); a production POST still needs
// `x-amz-content-sha256` over the exact body bytes, like every other write here (OAC).

import { isValidSecret, publicIdFromSecret, PUBLIC_ID_PATTERN } from '@whippin/shared';
import { FRIENDS_MAX, type FriendStore } from './friendStore';
import { errorResponse, json, type FnUrlEvent, type FnUrlResult } from './respond';

const FRIENDS_BODY_MAX_BYTES = 4_096;
const LIVE_HEADERS = { 'Cache-Control': 'no-store' } as const;

function bodyOf(event: FnUrlEvent): unknown {
  if (event.body == null) return null;
  const body = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  if (Buffer.byteLength(body) > FRIENDS_BODY_MAX_BYTES) throw new Error('request_too_large');
  return JSON.parse(body) as unknown;
}

export async function handleFriends(
  event: FnUrlEvent,
  friends: FriendStore,
  instant: Date,
  cors: Record<string, string>,
): Promise<FnUrlResult> {
  const responseHeaders = { ...cors, ...LIVE_HEADERS };
  const method = event.requestContext?.http?.method ?? 'GET';
  if (method !== 'POST') {
    return errorResponse(
      405,
      'method_not_allowed',
      'The friends route is POST-only: the player key authenticates in the body.',
      responseHeaders,
    );
  }

  let raw: unknown;
  try {
    raw = bodyOf(event);
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === 'request_too_large';
    return errorResponse(
      tooLarge ? 413 : 400,
      tooLarge ? 'payload_too_large' : 'bad_request',
      tooLarge ? 'Friends request body is too large.' : 'Body must be valid JSON.',
      responseHeaders,
    );
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return errorResponse(400, 'bad_request', 'Body must be an object.', responseHeaders);
  }
  const body = raw as Record<string, unknown>;

  // Authentication without accounts (#187): possession of the secret is the proof of
  // ownership, and the edges are keyed by the identity DERIVED from it — so the only graph
  // a caller can read or change is their own.
  if (!isValidSecret(body.secret)) {
    return errorResponse(
      400,
      'bad_request',
      'Body field "secret" must be the 32-hex-character player key.',
      responseHeaders,
    );
  }

  // The field name IS the verb and its value is the target, so a body can neither name an
  // operation with nothing to apply it to nor ask for two opposite things at once.
  const wantsAdd = body.add !== undefined;
  const wantsRemove = body.remove !== undefined;
  if (wantsAdd && wantsRemove) {
    return errorResponse(
      400,
      'bad_request',
      'Body may carry "add" or "remove", never both.',
      responseHeaders,
    );
  }
  const target = wantsAdd ? body.add : body.remove;
  if (target !== undefined && (typeof target !== 'string' || !PUBLIC_ID_PATTERN.test(target))) {
    return errorResponse(
      400,
      'bad_request',
      `Body field "${wantsAdd ? 'add' : 'remove'}" must be a 16-character player id.`,
      responseHeaders,
    );
  }

  const publicId = await publicIdFromSecret(body.secret);

  if (wantsAdd) {
    const friendId = target as string;
    // Nobody is their own friend, and an invite link opened by the player who shared it is
    // exactly how this arrives — it is a mistaken click, not a graph edge.
    if (friendId === publicId) {
      return errorResponse(400, 'self_link', 'A player cannot add themselves.', responseHeaders);
    }
    const result = await friends.link({
      publicId,
      friendId,
      createdAt: instant.toISOString(),
    });
    if (result.outcome === 'capped') {
      return errorResponse(
        409,
        'friend_limit',
        `One of the two players already has ${FRIENDS_MAX} friends.`,
        responseHeaders,
      );
    }
    // `link` already read the partition to decide the cap, so it answers with the resulting
    // list rather than leaving this route to Query for it a second time.
    return json(200, { friends: result.friends }, responseHeaders);
  }

  if (wantsRemove) {
    await friends.unlink(publicId, target as string);
  }

  return json(200, { friends: await friends.list(publicId) }, responseHeaders);
}
