// What a verified email link DOES to two accounts (#204): what it carries across, what it
// destroys, and what it promises to finish afterwards.
//
// The route (`link.ts`) owns the conversation — the code, the confirmation, the answers.
// The state changes are two steps, in the order that makes every partial failure safe:
//
//   1. COMMIT — `LinkStore.adopt`, ONE transaction: the challenge is consumed, the device
//      moves, the account being left is deleted with its profile row, the departure job
//      is persisted, and the ACTIVE DAY's play moves with the device (`supportedTuples`,
//      every tuple where the destination has nothing and the source has play). Indivisible,
//      because the half-states are not equally harmless: a device left on a DELETED account
//      is a player signed out mid-link with everything gone, and a round moved by an
//      adoption that never commits is play under an account nobody holds — the first cut
//      moved the play in separate writes BEFORE the commit and could leave exactly that,
//      which no retry, claim or takeover could then honestly own.
//   2. DRAIN the departure (#271). A deleted account LEAVES EVERY GROUP it was in — its
//      memberships are dropped, never carried across — and that fan-out cannot ride the
//      commit: a membership can land between a read and the transaction, and only a
//      re-read until empty is sure to catch it (a join asserts the account exists, so
//      after the commit nothing new can land). The job written in step 1 is what makes it
//      durable: idempotent, resumable, and its own last act is to delete itself.
//
// The solved-day credit a transferred sentence solve owes the adopting account's streak
// follows step 1 as a logged, non-fatal side effect, the round route's own rule for that
// rebuildable collection.

import { bestStreak, currentStreak, VOCAB_BUILDS } from '@whippin/shared';
import type { GroupStore } from './groupStore';
import type { PlayerHistoryStore } from './historyStore';
import type { LinkStore } from './linkStore';
import type { ScoreMode } from './scoreLimits';

// EVERY supported language × BOTH modes — "the active day" means all of them, not whichever
// route the linking device happens to be on (user-decided 2026-08-23). Which language a
// player was on lives in the browser and nowhere else, so a server that guessed would erase
// the round it guessed wrong about. The product is bounded (four tuples today), which is
// what makes evaluating all of them the cheap answer as well as the right one.
export function supportedTuples(): { lang: string; mode: ScoreMode }[] {
  const modes: ScoreMode[] = ['sentence', 'word'];
  return Object.keys(VOCAB_BUILDS).flatMap((lang) => modes.map((mode) => ({ lang, mode })));
}

// WHAT AN ACCOUNT IS WORTH, in the three numbers every surface that states one uses: the
// live streak, the best it has ever held, and its total days. SOLVED DAYS are the measure —
// they are what a streak is derived from, they are what a player would name if asked what
// they would miss, and they are bounded (one small read per language).
//
// It is read for two opposite reasons and states the same three either way: what a deletion
// is about to COST, and what a recovery just HANDED BACK. An account with no days at all is
// EMPTY for the confirmation's purpose — nothing to show, so nothing to confirm, which is
// exactly the fresh device that links immediately.
export interface AccountStakes {
  streak: number;
  best: number;
  days: number;
}

export async function accountStakes(
  history: PlayerHistoryStore,
  accountId: string,
  activeDay: number,
): Promise<AccountStakes> {
  const langs = Object.keys(VOCAB_BUILDS);
  const collections = await Promise.all(langs.map((lang) => history.solvedDays(accountId, lang)));
  return {
    // The BEST of each across languages, never their sum: a streak is a run of days in ONE
    // language, and adding two of them would state a number no streak screen ever shows.
    // The DAYS do sum, because a day played in either language is a day played.
    streak: collections.reduce((most, days) => Math.max(most, currentStreak(days, activeDay)), 0),
    best: collections.reduce((most, days) => Math.max(most, bestStreak(days)), 0),
    days: collections.reduce((total, days) => total + days.length, 0),
  };
}

// Finish whatever this account still owes. Normally there is nothing — one small Query over
// an empty partition — and after an erasing link there is exactly one job: the deleted
// account's group memberships to drop (`GroupStore.leaveAll` re-reads until empty).
//
// A failure is REPORTED, not thrown: the identity change has already committed, the answer
// the player is waiting for is about their account, and the job survives to be drained by
// the next call. The route says `departurePending` so the client can ask again.
export async function drainDepartures(
  links: LinkStore,
  groups: GroupStore,
  accountId: string,
): Promise<boolean> {
  let pending: string[];
  try {
    pending = await links.pendingDepartures(accountId);
  } catch (error) {
    console.warn('[link] pending departure lookup failed:', error);
    return false;
  }
  let done = true;
  for (const from of pending) {
    try {
      await groups.leaveAll(from);
      await links.clearDeparture(accountId, from);
    } catch (error) {
      // LOGGED and left queued. A membership pointing at a deleted account keeps a ghost on
      // a group's member count, so the job may not be abandoned — but it also may not fail
      // the link that already happened.
      console.warn(`[link] group departure of ${from} (adopted by ${accountId}) unfinished:`, error);
      done = false;
    }
  }
  return done;
}
