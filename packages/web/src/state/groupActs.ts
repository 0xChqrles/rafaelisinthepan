// The group ACTS every surface shares (#271): the board screen's create, invite, leave and
// remove, and the result's SEAT's create and invite — ONE write, ONE reading of what it
// answered, ONE error copy per failure and ONE invite message, so the two doors onto a group
// cannot say the same thing two ways.
//
// THE WRITE is one gesture: the deploy (a tokenless tap mints the account first), the signed
// POST, then the list the answer carries, published through `adoptGroups`. What it answered
// is read off the CODE, never the status alone (root AGENTS.md, the live routes): a 4xx that
// names a code is a REFUSAL, the server's verdict; a 5xx, a transport failure or a body with
// no code to read is a FAILURE — never a verdict, so its outcome is UNKNOWN (the write may
// have landed) and the list is READ AGAIN before the failure is said: what the screen then
// draws is what the server holds, and a create that did land is found there (`createGroup`)
// rather than sent twice. A request whose identity moved under it (another tab's adopt) is
// STALE: nothing is sent, or nothing it answered is published.

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
  | { kind: 'failed' }
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
  await loadGroups();
  return { kind: 'failed' };
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

// WHAT A WRITE THAT DID NOT LAND PUTS ON THE ERROR SURFACE — saying nothing would leave the
// player tapping a button that appears to do nothing. Null where there is nothing to say: it
// landed, the identity moved (nothing happened), or the screen answers the code itself (a
// stale succession: the leave asks again). A banned name has its own refusal (the server's
// `name_rejected`); the naming screen stays up under it, the name kept.
export type GroupFailure = 'account' | 'group' | 'limit' | 'name' | 'share';

export function failureOf(write: GroupWrite): GroupFailure | null {
  switch (write.kind) {
    case 'account':
      return 'account';
    case 'failed':
      return 'group';
    case 'refused':
      return write.error === 'group_limit'
        ? 'limit'
        : write.error === 'name_rejected'
          ? 'name'
          : write.error === 'successor_required'
            ? null
            : 'group';
    default:
      return null;
  }
}

// Each failure's title and note on the `ErrorScreen` (`share`: an invite neither the native
// sheet nor the clipboard delivered).
const FAILURE_COPY: Record<GroupFailure, { title: UiKey; note: UiKey }> = {
  account: { title: 'failedAccount', note: 'failedAccountNote' },
  share: { title: 'failedShare', note: 'failedShareNote' },
  limit: { title: 'groupLimit', note: 'groupLimitNote' },
  name: { title: 'groupNameRejected', note: 'groupNameRejectedNote' },
  group: { title: 'failedGroup', note: 'failedGroupNote' },
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
