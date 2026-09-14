// The #271 groups route on the ONE handler: `/groups`.
//
//   GET  /groups?id=<groupId>             — the PUBLIC face of one group: its name, its
//                                           creator and its members' faces — what the
//                                           invite landing draws before anyone joins, and
//                                           what the preview card is rendered from.
//   POST /groups  { token }               — the caller's groups;
//                 { token, create: true, name } — a new group, the caller its first member;
//                 { token, join: <groupId> }    — the membership an invite link's tap records;
//                 { token, leave: <groupId>[, successor] }
//                                         — the caller walks out. An OWNER leaving a group
//                                           of three or more NAMES a successor (409
//                                           `successor_required` until they do); of two,
//                                           the other member takes it; alone, the group
//                                           is deleted (user-decided 2026-09-14);
//                 { token, remove: <groupId>, member: <publicId> }
//                                         — the OWNER shows a member out.
//
// Every POST answers with the caller's groups as they now stand, so a client never has to
// guess what a write did (the retired friends route's house rule) — and every write is a
// POST for one reason: the device token is the auth (#216) and it travels in the BODY,
// never in a query string. The GET reads ONE query, the public group id (the /profile
// pattern), which is why the CloudFront `groups*` behavior forwards exactly `id`.
//
// Group creation is authenticated but NOT Turnstile-gated: a token already cost a
// challenge to mint, and GROUPS_MAX bounds what one account can create. A production
// POST needs `x-amz-content-sha256` over the exact body bytes, like every other write here.

import {
  GROUP_ID_PATTERN,
  generateGroupId,
  isValidName,
  PUBLIC_ID_PATTERN,
  type BoardPlayer,
  type GroupSummary,
  type PublicGroup,
} from '@whippin/shared';
import type { DeviceStore } from './deviceStore';
import {
  GROUP_MEMBERS_MAX,
  GROUPS_MAX,
  successionFor,
  type GroupRecord,
  type GroupStore,
} from './groupStore';
import { LIVE_HEADERS, readJsonObject, requireDevice } from './liveRoute';
import { isNameAllowed } from './nameFilter';
import type { ProfileStore } from './profileStore';
import { errorResponse, json, type FnUrlEvent, type FnUrlResult } from './respond';

export interface GroupHandlerDeps {
  groups: GroupStore;
  devices: DeviceStore;
  // The public read dresses the members with their faces, the board's own dressing.
  profiles: ProfileStore;
}

// A group's PUBLIC face (#271): what `GET /groups?id=` answers and what the `/g/<id>`
// preview renders — the record plus its members dressed with their profiles. A member
// whose ACCOUNT is gone (#204) is DROPPED, never dressed: the assigned fallback is still
// that player's own pseudonym and mark. A read that merely FAILED dresses blank and stays
// (the board's rule), and `answered` says whether every read answered — the preview
// caches only a face it did not have to fall back to.
export interface GroupFace {
  group: GroupRecord;
  members: BoardPlayer[];
  answered: boolean;
}

export async function readGroupFace(
  groups: GroupStore,
  profiles: ProfileStore,
  id: string,
): Promise<GroupFace | null> {
  const group = await groups.get(id);
  if (!group) return null;
  const members = await groups.members(id);
  let answered = true;
  const faces = await Promise.all(
    members.map(async ({ publicId }): Promise<BoardPlayer | null> => {
      try {
        const found = await profiles.get(publicId);
        if (!found.live) return null;
        return { publicId, name: found.profile?.name ?? '', avatar: found.profile?.avatar || null };
      } catch {
        answered = false;
        return { publicId, name: '', avatar: null };
      }
    }),
  );
  return { group, members: faces.filter((face): face is BoardPlayer => face !== null), answered };
}

export async function handleGroups(
  event: FnUrlEvent,
  deps: GroupHandlerDeps,
  instant: Date,
  cors: Record<string, string>,
): Promise<FnUrlResult> {
  const responseHeaders = { ...cors, ...LIVE_HEADERS };
  const method = event.requestContext?.http?.method ?? 'GET';

  if (method === 'GET') {
    const id = event.queryStringParameters?.id;
    if (typeof id !== 'string' || !GROUP_ID_PATTERN.test(id)) {
      return errorResponse(
        400,
        'bad_request',
        'Query parameter "id" must be a 16-character group id.',
        responseHeaders,
      );
    }
    const face = await readGroupFace(deps.groups, deps.profiles, id);
    if (!face) return errorResponse(404, 'unknown_group', 'No such group.', responseHeaders);
    const answer: PublicGroup = {
      id: face.group.id,
      name: face.group.name,
      createdBy: face.group.createdBy,
      members: face.members,
    };
    return json(200, answer, responseHeaders);
  }

  const parsed = readJsonObject(event, 'Groups', responseHeaders);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;

  // Authentication (#216): the memberships are keyed by the ACCOUNT the caller's device
  // token resolves to — so the only groups a caller can read or change are their own.
  const auth = await requireDevice(body, responseHeaders, deps.devices, instant);
  if (!auth.ok) return auth.response;
  const publicId = auth.value.account.accountId;
  const now = instant.toISOString();

  // The field name IS the verb and its value is the target, so a body can neither name an
  // operation with nothing to apply it to nor ask for two things at once.
  const verbs = (['create', 'join', 'leave', 'remove'] as const).filter(
    (verb) => body[verb] !== undefined,
  );
  if (verbs.length > 1) {
    return errorResponse(
      400,
      'bad_request',
      'Body may carry one of "create", "join", "leave" or "remove", never several.',
      responseHeaders,
    );
  }
  const verb = verbs[0];

  const mine = async (extra: Record<string, unknown> = {}) =>
    json(200, { groups: await listGroups(deps.groups, publicId), ...extra }, responseHeaders);

  if (verb === undefined) return mine();

  if (verb === 'create') {
    if (body.create !== true) {
      return errorResponse(400, 'bad_request', 'Body field "create" must be true.', responseHeaders);
    }
    // The NAME wears the player name's own charset (#188's shared rule: alphanumerics and
    // underscores, at most 16) — one rule for everything a person names here — and unlike
    // a player it cannot be empty: a tab with nothing on it is not a group.
    const name = body.name;
    if (typeof name !== 'string' || name.length === 0 || !isValidName(name)) {
      return errorResponse(
        400,
        'bad_request',
        'Body field "name" must be 1 to 16 letters, digits or underscores.',
        responseHeaders,
      );
    }
    if (!isNameAllowed(name)) {
      return errorResponse(400, 'name_rejected', 'This name is not allowed.', responseHeaders);
    }
    const id = generateGroupId();
    const outcome = await deps.groups.create({ id, name, createdBy: publicId, now });
    if (outcome === 'group_limit') {
      return errorResponse(
        409,
        'group_limit',
        `You are already in ${GROUPS_MAX} groups.`,
        responseHeaders,
      );
    }
    if (outcome === 'gone') return signedOut(responseHeaders);
    return mine({ created: id });
  }

  const target = body[verb];
  if (typeof target !== 'string' || !GROUP_ID_PATTERN.test(target)) {
    return errorResponse(
      400,
      'bad_request',
      `Body field "${verb}" must be a 16-character group id.`,
      responseHeaders,
    );
  }

  if (verb === 'join') {
    const outcome = await deps.groups.join({ id: target, publicId, now });
    switch (outcome) {
      case 'unknown_group':
        return errorResponse(404, 'unknown_group', 'This invite link has expired.', responseHeaders);
      case 'group_full':
        return errorResponse(
          409,
          'group_full',
          `This group already has ${GROUP_MEMBERS_MAX} members.`,
          responseHeaders,
        );
      case 'group_limit':
        return errorResponse(
          409,
          'group_limit',
          `You are already in ${GROUPS_MAX} groups.`,
          responseHeaders,
        );
      case 'gone':
        return signedOut(responseHeaders);
      default:
        // `joined` and `already` are both the answer "you are in": a re-tap on a shared
        // link is an ordinary event, not an error.
        return mine();
    }
  }

  if (verb === 'leave') {
    const successor = body.successor;
    if (successor !== undefined && (typeof successor !== 'string' || !PUBLIC_ID_PATTERN.test(successor))) {
      return errorResponse(
        400,
        'bad_request',
        'Body field "successor" must be a 16-character player id when present.',
        responseHeaders,
      );
    }
    const [group, members] = await Promise.all([deps.groups.get(target), deps.groups.members(target)]);
    // Not in it (or no such group): nothing to leave, and the list says so.
    if (!group || !members.some((member) => member.publicId === publicId)) return mine();
    const rule = successionFor(group, members, publicId, successor);
    if (rule.needsChoice) {
      return errorResponse(
        409,
        'successor_required',
        'Name the member who takes the group over before leaving it.',
        responseHeaders,
      );
    }
    await deps.groups.leave(target, publicId, rule.options);
    return mine();
  }

  // REMOVE: the owner shows a member out. Authorized by the group row, never by the
  // caller's say-so; and never on themselves — that is `leave`, with its succession.
  const member = body.member;
  if (typeof member !== 'string' || !PUBLIC_ID_PATTERN.test(member)) {
    return errorResponse(
      400,
      'bad_request',
      'Body field "member" must be a 16-character player id.',
      responseHeaders,
    );
  }
  if (member === publicId) {
    return errorResponse(400, 'bad_request', 'Leave the group instead of removing yourself.', responseHeaders);
  }
  const group = await deps.groups.get(target);
  if (!group) return errorResponse(404, 'unknown_group', 'No such group.', responseHeaders);
  if (group.createdBy !== publicId) {
    return errorResponse(403, 'not_creator', 'Only the group creator can remove a member.', responseHeaders);
  }
  await deps.groups.leave(target, member);
  return mine();
}

// The caller's groups as every POST answers them: the memberships off their own partition,
// each with its owner (the group row's fact — it changes hands) and who is in it (one
// consistent read + one Query per group, GROUPS_MAX at most) — what the board's picker,
// the global board's marks and the landing's "already a member" all read. A membership
// whose group row is gone (the last leave's deletion racing a join) is dropped from the
// answer rather than shown as a group nobody owns.
export async function listGroups(groups: GroupStore, publicId: string): Promise<GroupSummary[]> {
  const mine = await groups.listMine(publicId);
  const rows = await Promise.all(
    mine.map(async (held) => {
      const [group, members] = await Promise.all([groups.get(held.id), groups.members(held.id)]);
      if (!group) return null;
      return { ...held, createdBy: group.createdBy, members: members.map((member) => member.publicId) };
    }),
  );
  return rows.filter((row): row is GroupSummary => row !== null);
}

// The store repeats the live-account check inside its transaction; a refusal there is the
// CALLER's account having disappeared — the one answer that signs a device out.
function signedOut(headers: Record<string, string>): FnUrlResult {
  return errorResponse(401, 'unknown_device', 'This device is no longer signed in.', headers);
}
