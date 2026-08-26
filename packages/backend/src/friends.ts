// The #189 friends route on the ONE handler: POST /friends.
//
//   { token }                    — your list (the trusted board's population, #190);
//   { token, add: "<publicId>" } — the MUTUAL edge an invite link's click records;
//   { token, remove: "<id>" }    — the symmetric removal.
//
// Every call answers with the caller's current list, so a client never has to guess what a
// write did — and every call is a POST for one reason: the device token is the auth (#216)
// and it travels in the BODY, never in a query string. That is also why the read is a POST:
// the server resolves YOUR edges, and there is no way to ask for them without proving who
// you are. The route reads no query parameter at all, which is what its CloudFront
// behavior's empty query allow-list says (root AGENTS.md); a production POST still needs
// `x-amz-content-sha256` over the exact body bytes, like every other write here (OAC).

import { PUBLIC_ID_PATTERN } from '@whippin/shared';
import type { DeviceStore } from './deviceStore';
import { FRIENDS_MAX, type FriendStore } from './friendStore';
import { LIVE_HEADERS, readJsonObject, requireDevice } from './liveRoute';
import { errorResponse, json, type FnUrlEvent, type FnUrlResult } from './respond';

export async function handleFriends(
  event: FnUrlEvent,
  friends: FriendStore,
  devices: DeviceStore,
  instant: Date,
  cors: Record<string, string>,
): Promise<FnUrlResult> {
  const responseHeaders = { ...cors, ...LIVE_HEADERS };
  const method = event.requestContext?.http?.method ?? 'GET';
  if (method !== 'POST') {
    return errorResponse(
      405,
      'method_not_allowed',
      'The friends route is POST-only: the device token authenticates in the body.',
      responseHeaders,
    );
  }

  const parsed = readJsonObject(event, 'Friends', responseHeaders);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;

  // Authentication (#216): the edges are keyed by the ACCOUNT the caller's device token
  // resolves to — so the only graph a caller can read or change is their own.
  const auth = await requireDevice(body, responseHeaders, devices, instant);
  if (!auth.ok) return auth.response;

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

  const publicId = auth.value.account.accountId;

  if (wantsAdd) {
    const friendId = target as string;
    // Nobody is their own friend, and an invite link opened by the player who shared it is
    // exactly how this arrives — it is a mistaken click, not a graph edge.
    if (friendId === publicId) {
      return errorResponse(400, 'self_link', 'A player cannot add themselves.', responseHeaders);
    }
    // The target has to be a LIVE account (#204). An invite link carries a publicId, and an
    // email link can delete the account behind it: an unaccepted link for a deleted player
    // expires rather than writing an edge nobody is on the other end of. There is no
    // B -> A alias and no redirect — the address is what a returning player signs in with,
    // not the old id.
    if (!(await devices.accountExists(friendId))) {
      return errorResponse(
        404,
        'unknown_player',
        'This invite link has expired.',
        responseHeaders,
      );
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
