// The group ACTS every surface shares (#271): the board screen's create, invite, leave and
// remove, and the result's SEAT's create and invite — ONE write, ONE reading of what it
// answered, ONE error copy per failure, ONE answer the naming screen gives at its line and
// ONE invite message, so the two doors onto a group cannot say the same thing two ways.
//
// THE WRITE is one gesture: the deploy (a tokenless tap mints the account first), the signed
// POST, then the list the answer carries, published through `adoptGroups`. What it answered
// is read off the CODE, never the status alone (root AGENTS.md, the live routes): a 4xx that
// names a code is a REFUSAL, the server's verdict; a 5xx, a transport failure or a body with
// no code to read is a FAILURE — never a verdict, so its outcome is UNKNOWN (the write may
// have landed) and the list is READ AGAIN, by a read sent after the write, before the failure
// is said: what the screen then draws is what the server holds, and a create that did land is
// found there (`createGroup`) rather than sent twice. When that read cannot be had either,
// nothing is known: the write answers `unknown`, which claims nothing about the group. A
// request whose identity moved under it (another tab's adopt) is STALE: nothing is sent, or
// nothing it answered is published.

import { groupsUrl, parseGroups, postGroupsBody, type GroupsBody } from '../api';
import { ensureRequestIdentity, identityEpoch } from '../identity';
import { t, type UiKey } from '../i18n';
import { pathForGroupInvite } from '../langs';
import { adoptGroups, loadGroups, useGroupsStore } from './groups';
import { adoptSignedOutVerdict } from './signedOutVerdict';

export type GroupWrite =
  // The list now stands as answered (and `created` is the id a create minted).
  | { kind: 'done'; created?: string }
  | { kind: 'refused'; error: string }
  // The deploy before it failed: no account, nothing sent.
  | { kind: 'account' }
  // The answer was lost, and the list read again after it holds what the server holds — the
  // act's own reading (`createGroup`, `leaveGroup`, `removeMember`) says whether it landed.
  | { kind: 'failed' }
  // The answer was lost, and so was the read again: it may have landed, or not.
  | { kind: 'unknown' }
  | { kind: 'stale' };

// The refusal's code, or null where the body names none.
async function codeOf(response: { json(): Promise<unknown> }): Promise<string | null> {
  try {
    const error = ((await response.json()) as { error?: unknown } | null)?.error;
    return typeof error === 'string' && error !== '' ? error : null;
  } catch {
    return null;
  }
}

// `epoch` is the identity the caller's screen was drawn for: a write built from account A's
// screen is never sent as account B.
export async function writeGroups(
  epoch: string | null,
  body: (token: string) => GroupsBody,
): Promise<GroupWrite> {
  let request;
  try {
    request = await ensureRequestIdentity(epoch);
  } catch {
    return { kind: 'account' };
  }
  if (!request) return { kind: 'stale' };
  try {
    const response = await postGroupsBody(groupsUrl(), body(request.identity.token));
    if (identityEpoch() !== request.epoch) return { kind: 'stale' };
    if (!response.ok) {
      // (The code is read off a copy: the sign-out verdict reads the body itself.)
      const copy = response.clone();
      await adoptSignedOutVerdict(response, request.epoch);
      const error = response.status < 500 ? await codeOf(copy) : null;
      if (error !== null) return { kind: 'refused', error };
    } else {
      const answer = parseGroups(await response.json());
      adoptGroups(answer, request.identity.accountId);
      return { kind: 'done', created: answer.created };
    }
  } catch {
    // (An unknown outcome, like the 5xx above: read below.)
  }
  return (await loadGroups({ fresh: true })) ? { kind: 'failed' } : { kind: 'unknown' };
}

// THE CREATE, the one write that is not idempotent (each mints a new group): a failure whose
// outcome is unknown is answered by the list read again — a group of this name that is ours
// and was not there before the tap is the one this tap made, and the create LANDED.
export async function createGroup(epoch: string | null, name: string): Promise<GroupWrite> {
  const before = new Set((useGroupsStore.getState().groups ?? []).map((group) => group.id));
  const write = await writeGroups(epoch, (token) => ({ token, create: true, name }));
  if (write.kind !== 'failed') return write;
  const made = (useGroupsStore.getState().groups ?? []).find(
    (group) => !before.has(group.id) && group.name === name,
  );
  return made ? { kind: 'done', created: made.id } : write;
}

// THE LEAVE and THE REMOVE, answered the create's way: a write whose outcome is unknown is
// answered by the list read again — the group gone from my list is a leave that LANDED, the
// member gone from the group's members a remove that did — so what the error surface then
// says ("STILL IN THE GROUP", "MEMBER NOT REMOVED") is what the list holds.
export async function leaveGroup(
  epoch: string | null,
  group: string,
  body: (token: string) => GroupsBody,
): Promise<GroupWrite> {
  const write = await writeGroups(epoch, body);
  if (write.kind !== 'failed') return write;
  const held = useGroupsStore.getState().groups;
  return held !== null && !held.some((g) => g.id === group) ? { kind: 'done' } : write;
}

export async function removeMember(epoch: string | null, group: string, member: string): Promise<GroupWrite> {
  const write = await writeGroups(epoch, (token) => ({ token, remove: group, member }));
  if (write.kind !== 'failed') return write;
  const still = (useGroupsStore.getState().groups ?? []).find((g) => g.id === group);
  return still !== undefined && !still.members.includes(member) ? { kind: 'done' } : write;
}

// THE NAMING SCREEN'S OWN ANSWERS: the two refusals of a create that are about what the player
// typed or holds — a banned name (`name_rejected`) and their own cap (`group_limit`) — said AT
// the prompt's line (the name shaking in the danger ink, or CREATE going dark), never over it.
export type CreateRefusal = 'name' | 'limit';

export function createRefusalOf(write: GroupWrite): CreateRefusal | null {
  if (write.kind !== 'refused') return null;
  return write.error === 'name_rejected' ? 'name' : write.error === 'group_limit' ? 'limit' : null;
}

// What the naming screen hears back from its surface's create: it LANDED (the name is inked
// in), a refusal it answers at its line, or anything else — the surface's error screen speaks
// (or nothing at all, the identity having moved) and the screen stays up, the name kept.
export type CreateVerdict = 'created' | CreateRefusal | 'other';

export function createVerdictOf(write: GroupWrite): CreateVerdict {
  if (write.kind === 'done' && write.created) return 'created';
  return createRefusalOf(write) ?? 'other';
}

// WHAT A WRITE THAT DID NOT LAND PUTS ON THE ERROR SURFACE — saying nothing would leave the
// player tapping a button that appears to do nothing — NAMED BY THE ACT, by what was lost.
// Null where there is nothing to say: it landed, the identity moved (nothing happened), or
// the screen answers the code itself (a stale succession: the leave asks again; a create's
// own refusals: the naming screen answers at its line).
export type GroupAct = 'create' | 'leave' | 'remove';
export type GroupFailure = 'account' | 'share' | 'unknown' | GroupAct;

export function failureOf(act: GroupAct, write: GroupWrite): GroupFailure | null {
  switch (write.kind) {
    case 'account':
      return 'account';
    case 'unknown':
      return 'unknown';
    case 'failed':
      return act;
    case 'refused':
      if (write.error === 'successor_required') return null;
      if (act === 'create' && createRefusalOf(write) !== null) return null;
      return act;
    default:
      return null;
  }
}

// Each failure's title and note on the `ErrorScreen` (`share`: an invite neither the native
// sheet nor the clipboard delivered; `unknown`: a write nothing could be read about, whose
// words claim nothing and invite no second try).
const FAILURE_COPY: Record<GroupFailure, { title: UiKey; note: UiKey }> = {
  account: { title: 'failedAccount', note: 'failedAccountNote' },
  share: { title: 'failedShare', note: 'failedShareNote' },
  unknown: { title: 'noAnswer', note: 'unknownGroupNote' },
  create: { title: 'failedCreate', note: 'failedGroupNote' },
  leave: { title: 'failedLeave', note: 'failedGroupNote' },
  remove: { title: 'failedRemove', note: 'failedGroupNote' },
};

export function groupFailureCopy(lang: string, failure: GroupFailure): { title: string; note: string } {
  const copy = FAILURE_COPY[failure];
  return { title: t(lang, copy.title), note: t(lang, copy.note) };
}

// THE INVITE is both "join us" and "come play": one line of copy, then the link (`/g/<id>`,
// the server-drawn preview). Delivery is `useShare({ tracked: false })`'s: the `share` event
// counts a solved day's result, never an invite.
export function inviteText(lang: string, origin: string, groupId: string): string {
  return `${t(lang, 'boardInviteText')}\n${origin}${pathForGroupInvite(groupId)}`;
}
