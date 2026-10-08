// DELETING THE ACCOUNT, by its own player (#207): the act behind `/account`'s DELETE
// ACCOUNT and its confirmation — the request, what its answer means, and what the device
// does once the account is gone.
//
// **THE OUTCOME IS READ OFF THE ANSWER'S CODE, AND AN UNKNOWN ONE IS READ AGAIN** (the live
// routes' rule): a 5xx, a dropped connection or an unreadable body says nothing about whether
// the deletion committed, so the device asks where it stands (`readDeviceStanding`, the plain
// `{token}` list) before it says anything. A token that authenticates no more — on the delete
// itself, or on that read — IS the deletion: the account row is gone, and nothing on it can
// sign in again. A list that comes back means the account stands; the confirmation says the
// act did not go through, in place, and the player may press DELETE again. And when that read
// is lost too, NOTHING IS KNOWN, and the confirmation says exactly that (`unknown`, the house
// NO ANSWER) — never "nothing was deleted", which it cannot know. DELETE stays live: pressed
// again, a deletion that had landed answers `unknown_device`, which is the deletion.
//
// **AN UNKNOWN DELETION IS REMEMBERED, for this tab** (`asked`): if it did land, the next
// private call anywhere in the app answers `unknown_device`, and the signed-out verdict it
// raises — or a sibling tab's tombstone reaching this one — NAMES the account the player
// asked to erase. That verdict is the deletion arriving late, not a sign-out to explain: the
// device forgets the account and goes home, exactly as on a confirmed deletion
// (`watchForEcho`), and the signed-out screen never stands for it.
//
// **ONCE IT IS GONE THE DEVICE FORGETS EVERYTHING, and lands home as a brand-new visitor**
// — never on the signed-out screen: the deletion was the player's own act, there is nothing
// to reconnect to, and a screen naming the account they just erased would be a lie about
// what happened. Three halves, each the ONE spelling of its concern:
//   - the identity: `startFreshDevice` (identity.ts) — the stored token removed, no tombstone
//     left, the next deploy button minting fresh. It lifts a tombstone too, which is what a
//     private read racing the deletion may already have written: an in-flight call answered
//     `unknown_device` the moment the account went, and raised the signed-out verdict before
//     this answer landed. That verdict NAMES the account deleted, so it is this deletion's
//     own echo, and it is lifted with the rest;
//   - the transient caches (rounds, history, the summary, groups, the live board):
//     `identityScope`, on the identity's change that `startFreshDevice` publishes;
//   - the persisted record — the outbox, the preferences, the tutorial's progress and the
//     placeholder seed: `gameStore.forgetAll`, so the next account wears a new face.
//
// FENCED like every authoritative answer: it applies only while the device still holds the
// identity that asked (or the signed-out verdict naming it). A sibling tab that installed
// another account meanwhile is not wiped by an answer about the one this tab left.

import { deleteAccount, readDeviceStanding, type DeleteAccountAnswer, type DeviceStanding } from '../api';
import {
  currentRequestIdentity,
  startFreshDevice,
  useIdentityStore,
  type DeviceIdentity,
} from '../identity';
import { navigate } from '../routing';
import { useGameStore } from './gameStore';

// What the confirmation answers with:
//   - `deleted`  the account is gone (the device has already forgotten it);
//   - `changed`  the device is on another account now — nothing was deleted;
//   - `failed`   nothing was deleted: the server refused it, or the account was read standing
//                after the answer was lost — the act may be pressed again;
//   - `unknown`  no readable answer, even read again: it may have landed. The act may be
//                pressed again (a deletion that had landed answers `unknown_device` then,
//                which is `deleted`), and meanwhile its echo is watched for (above).
export type DeletionOutcome = 'deleted' | 'changed' | 'failed' | 'unknown';

// The answers made one verdict — pure over its two requests, so the mapping can be read and
// tested on its own: the delete's answer, and, only when that one is UNKNOWN, the device's
// standing read after it.
export async function deletionOutcome(
  send: () => Promise<DeleteAccountAnswer>,
  reread: () => Promise<DeviceStanding>,
): Promise<DeletionOutcome> {
  const answer = await send();
  if (answer === 'deleted' || answer === 'gone') return 'deleted';
  if (answer === 'changed') return 'changed';
  if (answer === 'refused') return 'failed';
  const standing = await reread();
  if (standing === 'gone') return 'deleted';
  return standing === 'standing' ? 'failed' : 'unknown';
}

type AccountIds = Pick<DeviceIdentity, 'accountId' | 'deviceId'>;

// The account this tab asked to delete with no verdict yet, and the store subscription
// watching for its echo. Module state: one confirmation, one tab.
let asked: AccountIds | null = null;
let stopWatching: (() => void) | null = null;

function settle(): void {
  asked = null;
  stopWatching?.();
  stopWatching = null;
}

// A signed-out verdict naming the account asked about IS its deletion (the root rule: a
// token that authenticates no more after a delete is the delete). Zustand calls a subscriber
// in the same tick as the write that raised the verdict, so the device forgets the account
// before the signed-out screen ever renders.
function echoed(state: { signedOut: boolean; signedOutAs: AccountIds | null }): void {
  if (asked === null || !state.signedOut || state.signedOutAs?.accountId !== asked.accountId) return;
  const gone = asked;
  settle();
  if (forgetDeletedAccount(gone)) navigate('/', { replace: true });
}

function watchForEcho(deleted: AccountIds): void {
  asked = { accountId: deleted.accountId, deviceId: deleted.deviceId };
  stopWatching ??= useIdentityStore.subscribe(echoed);
  // A verdict may already stand: another private call answered while this one was read again.
  echoed(useIdentityStore.getState());
}

// Forget the deleted account on this device — only while the device is still THAT account's:
// holding its identity, or showing the signed-out verdict that names it (the deletion's own
// echo, above). The identity is left FENCED (`startFreshDevice`'s `deleted`), so a sibling
// tab's late verdict about it is taken back out of the shared key rather than shown.
// Returns whether it applied.
export function forgetDeletedAccount(deleted: AccountIds): boolean {
  const { identity, signedOut, signedOutAs } = useIdentityStore.getState();
  const ours =
    identity !== null
      ? identity.accountId === deleted.accountId && identity.deviceId === deleted.deviceId
      : signedOut && signedOutAs !== null && signedOutAs.accountId === deleted.accountId;
  if (!ours) return false;
  startFreshDevice({ accountId: deleted.accountId, deviceId: deleted.deviceId });
  useGameStore.getState().forgetAll();
  return true;
}

// THE ACT: the confirmation's DELETE. Never mints (a device with no account has nothing to
// delete, and the control is not drawn for it). On `deleted` the device forgets the account
// and goes home — the same hand-off as the signed-out screen's PLAY: App's home redirect
// resolves where, and a brand-new visitor meets the invitation there.
export async function deleteThisAccount(): Promise<DeletionOutcome> {
  const held = currentRequestIdentity();
  if (held === null) return 'failed';
  const { identity } = held;
  const outcome = await deletionOutcome(
    () => deleteAccount(identity),
    () => readDeviceStanding(identity.token),
  );
  if (outcome === 'unknown') {
    watchForEcho(identity);
    // The echo may already have answered it (a verdict standing when the watch began).
    return asked === null ? 'deleted' : 'unknown';
  }
  settle();
  if (outcome === 'deleted') {
    forgetDeletedAccount(identity);
    navigate('/', { replace: true });
  }
  return outcome;
}

// Test seam: drop this module's state (it must not leak between tests).
export function resetAccountDeletion(): void {
  settle();
}
