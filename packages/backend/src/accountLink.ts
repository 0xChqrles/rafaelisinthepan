// What a verified email link DOES to two accounts (#204): what it carries across, what it
// destroys, and what it promises to finish afterwards.
//
// The route (`link.ts`) owns the conversation — the code, the confirmation, the answers.
// This file owns the state changes, in the order that makes every partial failure safe:
//
//   1. TRANSFER the active day's play, tuple by tuple. Each move is its own atomic
//      condition, and every one of them is a no-op the second time, so a link interrupted
//      here and retried converges.
//   2. COMMIT the identity — `LinkStore.adopt`, ONE transaction: the challenge is consumed,
//      the device moves, the account being left is deleted with its profile row, and the
//      friend-merge job is persisted. Indivisible, because the half-states are not equally
//      harmless: a device left on a DELETED account is a player signed out mid-link with
//      everything gone, which is the one outcome this flow may never produce.
//   3. DRAIN the friend merge. Up to 200 mutual edges is 800 rows, which cannot fit one
//      transaction, so the job written in step 2 is what makes the fan-out durable: it is
//      idempotent, resumable, and its own last act is to delete itself.
//
// Step 1 runs BEFORE step 2 on purpose. Either order can be interrupted; only this one is
// recoverable. Moves-then-commit leaves the day's round under the account nobody holds yet,
// and the player's retry (they still hold the device, and their code is still unspent) moves
// nothing, commits, and lands right. Commit-then-moves leaves the round in an account that
// has just been DELETED, with nothing left to retry from.

import { bestStreak, dayNumber, currentStreak, VOCAB_BUILDS } from '@whippin/shared';
import { FRIENDS_MAX, type FriendStore, type FriendTransfer } from './friendStore';
import type { PlayerHistoryStore } from './historyStore';
import type { LinkStore } from './linkStore';
import type { RoundKey, RoundStore } from './roundStore';
import type { ScoreMode } from './scoreLimits';
import type { ScoreStore } from './scoreStore';

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

export interface TransferStores {
  rounds: RoundStore;
  scores: ScoreStore;
  history: PlayerHistoryStore;
}

// Move the active day's play from the account being left to the one being adopted, for every
// supported tuple where the destination has NOTHING and the source has something. Answers
// the tuples that actually moved, which is what the route reports.
//
// "Has nothing" is keyed on GUESSES rather than on solving, because a solved round is just a
// round whose last guess landed rank 0 — one rule covers both. And it is the only
// unambiguous case: if the destination holds a partial round and the source a solve, that is
// two real logs for one day with no honest resolution (a union changes the try count and the
// score; a concatenation makes the run ruler replay nonsense).
export async function transferActiveDay(
  stores: TransferStores,
  from: string,
  to: string,
  date: string,
): Promise<RoundKey[]> {
  const moved: RoundKey[] = [];
  for (const { lang, mode } of supportedTuples()) {
    const key: RoundKey = { date, lang, mode };
    const state = await stores.rounds.transfer(key, from, to);
    if (!state) continue;
    moved.push(key);
    // The recorded row follows the round it was derived from, so the day's leaderboard names
    // the account that now holds the play. A round with no row (unfinished, capped, late, or
    // refused by the IP allowance) simply has nothing to move.
    await stores.scores.transfer(key, from, to);
    // A transferred SENTENCE solve owes the adopting account's streak its day (#211). The
    // credit is a set insert, so it is idempotent by construction and a retried link cannot
    // double-count it.
    if (mode === 'sentence' && state.solved === true) {
      await stores.history.recordSolvedDay({ publicId: to, lang, day: dayNumber(date) });
    }
  }
  return moved;
}

// One PASS of the friend merge: read what is left of the account being deleted, decide each
// friendship's fate, and write the batch. The rules are #204's, in order:
//
//   1. keep every friendship the adopting account already has;
//   2. remove the two accounts themselves and the duplicates from the list being merged;
//   3. fill the remaining capacity with the rest, OLDEST FIRST, ties by friend id;
//   4. rewrite both directions of every kept friendship onto the adopting account;
//   5. when no slot remains, DROP the friendship and remove both facing edges — no link is
//      left pointing at an account that no longer exists.
//
// Deciding it per pass rather than once is what makes the job resumable: whatever a partial
// batch already moved is simply absent from the next read, and the ordering rule picks up
// exactly where it left off.
async function mergePass(friends: FriendStore, from: string, to: string): Promise<number> {
  const leaving = await friends.entries(from);
  if (leaving.length === 0) return 0;
  const held = new Set(await friends.list(to));
  // The two accounts' own edge to each other, if the player ever invited themselves across
  // devices: it is DROPPED, never moved — the adopting account cannot befriend itself, and
  // the edge would otherwise survive pointing at a deleted player.
  const drops: FriendTransfer[] = [];
  const candidates: typeof leaving = [];
  for (const edge of leaving) {
    // A duplicate needs only its two `from`-facing rows removed: the adopting account
    // already holds this friendship, so there is nothing to write on its side.
    if (edge.friendId === to || held.has(edge.friendId)) {
      drops.push({ friendId: edge.friendId, keep: false, createdAt: edge.createdAt });
    } else {
      candidates.push(edge);
    }
  }
  candidates.sort((a, b) =>
    a.createdAt === b.createdAt
      ? a.friendId < b.friendId
        ? -1
        : 1
      : a.createdAt < b.createdAt
        ? -1
        : 1,
  );
  // The present cap is ACCEPTED here (#204): a future pagination change may remove it, but
  // this issue neither waits for that work nor promises to recover an edge dropped now.
  const room = Math.max(0, FRIENDS_MAX - held.size);
  const moves: FriendTransfer[] = [
    ...drops,
    ...candidates.map((edge, index) => ({
      friendId: edge.friendId,
      keep: index < room,
      createdAt: edge.createdAt,
    })),
  ];
  await friends.transfer(from, to, moves);
  return moves.length;
}

// A merge cannot need more passes than the cap allows friendships, and each pass writes at
// least one move or reports zero and ends the loop — so this bound can only be reached by a
// store that is not shrinking the partition it was told to, which is a bug rather than a
// retry.
const MERGE_MAX_PASSES = FRIENDS_MAX + 1;

export async function mergeFriends(friends: FriendStore, from: string, to: string): Promise<void> {
  for (let pass = 0; pass < MERGE_MAX_PASSES; pass += 1) {
    if ((await mergePass(friends, from, to)) === 0) return;
  }
  throw new Error(`Friend merge from ${from} did not converge.`);
}

// Finish whatever this account still owes. Normally there is nothing — one small Query over
// an empty partition — and after a link there is exactly one job.
//
// A failure is REPORTED, not thrown: the identity change has already committed, the answer
// the player is waiting for is about their account, and the job survives to be drained by
// the next call. The route says `mergePending` so the client can ask again.
export async function drainMerges(
  links: LinkStore,
  friends: FriendStore,
  accountId: string,
): Promise<boolean> {
  let pending: string[];
  try {
    pending = await links.pendingMerges(accountId);
  } catch (error) {
    console.warn('[link] pending merge lookup failed:', error);
    return false;
  }
  let done = true;
  for (const from of pending) {
    try {
      await mergeFriends(friends, from, accountId);
      await links.clearMerge(accountId, from);
    } catch (error) {
      // LOGGED and left queued. The edges are consented relationships, so the job may not be
      // abandoned — but it also may not fail the link that already happened.
      console.warn(`[link] friend merge ${from} -> ${accountId} unfinished:`, error);
      done = false;
    }
  }
  return done;
}
