// What deleting an account (#207) erases AFTER the deletion itself, and the hourly worker
// that finishes it.
//
// The deletion a player asks for is TWO steps, in the order that makes every partial
// failure safe:
//
//   1. THE BOUNDARY — `LinkStore.deleteAccount`, ONE transaction: the account row, the
//      profile row, the address binding and the PURGE job. From that commit on, every
//      device token of the account fails authentication (the account-existence check), no
//      board, preview or share dresses it, and the address reaches nobody. The route
//      (`devices.ts`) then revokes the device items and drops the group memberships at once
//      (`revokeDevices`, `departGroups` below) — the groups because other players SEE them —
//      both best-effort, since the job owes them again.
//   2. THE PURGE — `purgeAccount`, run by the worker (`purgeWorker.ts`, hourly) for every
//      queued job: the memberships and devices once more, then every round and its score
//      row, then whatever is left in the player partition. Every step is IDEMPOTENT, so a
//      job interrupted anywhere is simply run again: the deletions themselves are the
//      progress, and there is no cursor to keep. The job is cleared only by a purge that
//      finished.
//
// A row is never half a pair here. A score row is deleted BEFORE the round it was earned on
// (the purge finds scores through the rounds, so the reverse would orphan a score for good
// if the run stopped between the two), and the player partition is swept only after the
// group departure, so no membership pair is ever cut in half.

import { isBonusAddress } from '@whippin/shared';
import { drainDepartures } from './accountLink';
import type { DeviceRecord, DeviceStore } from './deviceStore';
import type { GroupStore } from './groupStore';
import type { LinkStore } from './linkStore';
import type { RoundStore } from './roundStore';
import type { ScoreStore } from './scoreStore';

export interface PurgeDeps {
  links: LinkStore;
  groups: GroupStore;
  devices: DeviceStore;
  rounds: RoundStore;
  scores: ScoreStore;
}

// How long a job waits before it is purged. A request that AUTHENTICATED just before the
// deletion committed may still be writing — a guess, a score, a solved day — and the API
// Lambda's own timeout (10 s) bounds how long. A purge run inside that window could clear
// the job and leave the late row under a deleted account forever, so a job younger than
// this is left for the next run; the hourly schedule makes the wait invisible.
export const PURGE_SETTLE_MS = 60_000;

// Sign out EVERY device of the account by deleting its base item: the account-device index
// lists them, and `known` adds the ones this request already holds (the calling device —
// the index is eventually consistent, and may not show a device created a moment ago). Each
// revocation is conditioned on the account, so a device item a later bootstrap re-parented
// onto a fresh identity answers `mismatch` and is left alone. Throws on a store failure.
export async function revokeDevices(
  devices: DeviceStore,
  accountId: string,
  known: readonly DeviceRecord[] = [],
): Promise<void> {
  const listed = await devices.list(accountId);
  const all = [
    ...listed,
    ...known.filter((device) => !listed.some((row) => row.revokeKey === device.revokeKey)),
  ];
  for (const device of all) await devices.revoke(accountId, device.deviceId, device.revokeKey);
}

// The GROUP DEPARTURE a deleted account owes (#271's succession rule, with nobody choosing:
// owned groups go to the oldest other membership, emptied groups are deleted), then any
// departure this account still owed as an ADOPTER (#204's job queue, drained the link's
// way). True when both are done. A failure is LOGGED and answered false, never thrown: the
// route has already deleted the account, and the purge job keeps it owed.
export async function departGroups(
  links: LinkStore,
  groups: GroupStore,
  accountId: string,
): Promise<boolean> {
  try {
    await groups.leaveAll(accountId);
  } catch (error) {
    console.warn(`[purge] group departure of ${accountId} unfinished:`, error);
    return false;
  }
  return drainDepartures(links, groups, accountId);
}

// Erase everything a deleted account left behind. TRUE when every step finished, false when
// the group departure did not (the job must stay); a store failure on a later step throws.
export async function purgeAccount(deps: PurgeDeps, accountId: string): Promise<boolean> {
  // 1. The memberships, AGAIN: the route's own attempt may have failed, and nothing else
  //    here may run before them — the partition sweep below would otherwise delete the
  //    player's half of a membership the group still lists.
  if (!(await departGroups(deps.links, deps.groups, accountId))) return false;
  // 2. The device items the route did not reach, or the index did not show it yet.
  await revokeDevices(deps.devices, accountId);
  // 3. Every round, and for a DATED round the score row earned on it — score first (above).
  //    A bonus is credited nothing, so it has no score row to look for.
  for (const key of await deps.rounds.listKeys(accountId)) {
    if (!isBonusAddress(key.date)) await deps.scores.remove(key, accountId);
    await deps.rounds.remove(key, accountId);
  }
  // 4. Whatever is left of the player partition: the solved-day collections, and any row a
  //    late write put back.
  await deps.links.purgePlayer(accountId);
  return true;
}

export interface PurgeRun {
  // Jobs queued when the run started.
  jobs: number;
  // Purged and cleared.
  done: number;
  // Not tried: too young (`PURGE_SETTLE_MS`), or the deadline came first.
  left: number;
  // Tried and unfinished — a step threw, or the departure did not finish. Still queued.
  failed: number;
}

// Purge every queued job, OLDEST FIRST, until `deadlineMs` (an instant in `now()`'s epoch
// milliseconds): a job is only STARTED before it, so the caller sets it far enough inside
// its own time limit for one purge to finish. One job's failure is logged and the next is
// tried; a job is cleared only when its purge finished.
export async function runPurges(
  deps: PurgeDeps,
  options: { deadlineMs: number; now?: () => number },
): Promise<PurgeRun> {
  const now = options.now ?? Date.now;
  const jobs = await deps.links.pendingPurges();
  const run: PurgeRun = { jobs: jobs.length, done: 0, left: 0, failed: 0 };
  for (const job of jobs) {
    const at = now();
    if (at >= options.deadlineMs) {
      run.left += 1;
      continue;
    }
    const enqueuedAt = Date.parse(job.enqueuedAt);
    if (Number.isFinite(enqueuedAt) && at - enqueuedAt < PURGE_SETTLE_MS) {
      run.left += 1;
      continue;
    }
    try {
      if (await purgeAccount(deps, job.accountId)) {
        await deps.links.clearPurge(job.accountId);
        run.done += 1;
      } else {
        run.failed += 1;
      }
    } catch (error) {
      console.warn(`[purge] purge of ${job.accountId} unfinished:`, error);
      run.failed += 1;
    }
  }
  return run;
}
