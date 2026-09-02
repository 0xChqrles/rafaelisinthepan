// Email account linking (#204): what the server stores between "send me a code" and
// "this device is now that account".
//
// FOUR item shapes, all on the score table beside everything else:
//
//   `link#<emailHash>` / `challenge`   — the pending 6-digit code (HASHED), its attempt
//                                        count, and a TTL. One per address, replaced by a
//                                        re-send.
//   `email#<emailHash>` / `email`      — the BINDING: which account this address reaches.
//                                        Create-only, so two devices racing one address
//                                        converge on the account that won.
//   `linksend#<scope>#<hash>` / `send`  — a send allowance: the instants of the sends still
//                                        inside the ROLLING window, with its own TTL. One per
//                                        address and one per IP.
//   `merge#<toAccountId>` / `from#<fromAccountId>`
//                                      — the durable FRIEND-MERGE job. Up to 200 mutual
//                                        edges cannot fit one 100-item transaction, so the
//                                        link commits a job and the fan-out drains behind
//                                        it, idempotently and resumably.
//
// **The address is stored HASHED wherever it is a KEY** and in clear only on the account
// row it belongs to. A key is a value anyone reading the table can enumerate; the account
// row is the one place the address is the player's own data rather than an index.
//
// The BINDING is the one thing here that outlives a request, and it is what makes the whole
// flow one button: after the code is verified the server looks the address up and either
// finds nobody (bind the caller's account) or finds an account (adopt it). The player never
// has to say whether they are new or returning — which is exactly what makes the
// second-device problem tractable, because there is nothing to detect.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { LINK_CODE_TTL_SECONDS } from '@whippin/shared';

// The KEY spelling of an address. SHA-256 of the CANONICAL form (`normalizeEmail`), so one
// address has exactly one key and a table dump enumerates no inboxes. It is deliberately
// NOT the HMAC the code uses: this one has to be reproducible from the address alone, on
// every instance, with no secret loaded.
export function emailHash(normalizedEmail: string): string {
  return createHash('sha256').update(normalizedEmail, 'utf8').digest('hex');
}

// The stored form of a 6-digit code. HMAC rather than a bare hash because the space is one
// million values: a bare SHA-256 of every possible code is a table anyone can precompute,
// so a table dump would hand over every pending challenge. The address is mixed in so a
// digest lifted from one row cannot be replayed against another.
export function linkCodeHash(secret: string, normalizedEmail: string, code: string): string {
  return createHmac('sha256', secret).update(`link-code:${normalizedEmail}:${code}`).digest('hex');
}

// Constant-time comparison of two hex digests of equal length. A code check that returns
// early on the first differing byte leaks, over enough attempts, which prefix was right.
export function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface LinkChallenge {
  codeHash: string;
  // How many verifications this challenge has already refused. Bounded by
  // LINK_CODE_MAX_ATTEMPTS, after which the challenge is spent.
  attempts: number;
  createdAt: string;
  // Unix seconds, the table's TTL attribute: DynamoDB removes a stale challenge on its own,
  // and every reader checks the instant anyway (TTL deletion is best-effort and lags).
  expiresAt: number;
}

// What one verification did to the stored challenge:
//   ok        — the code matched; the challenge stands until the link's own transaction
//               consumes it (a failure after this point must be retryable);
//   wrong     — it did not match, and the attempt was counted. `attemptsLeft` is what the
//               screen shows;
//   spent     — the attempts are exhausted, or a concurrent verification consumed it;
//   expired   — the challenge is past its instant;
//   none      — no challenge stands for this address.
export type LinkVerifyOutcome = 'ok' | 'wrong' | 'spent' | 'expired' | 'none';

export interface LinkVerifyResult {
  outcome: LinkVerifyOutcome;
  attemptsLeft: number;
}

export interface EmailBinding {
  accountId: string;
  createdAt: string;
}

export interface LinkSendAllowance {
  scope: string;
  hash: string;
  limit: number;
}

// A verified bind can still lose one of three races before its transaction lands. They are
// answers, not infrastructure failures: the route either follows the binding that won,
// re-reads the caller's account, or asks for a fresh code.
export type LinkBindOutcome = 'bound' | 'taken' | 'account_changed' | 'challenge_changed';

// The adoption transaction carries the same optimistic facts. `device_changed` includes a
// committed write whose response was lost: the route re-reads the token and treats it as
// success only when it now resolves to the intended account.
export type LinkAdoptOutcome =
  | 'adopted'
  | 'account_changed'
  | 'challenge_changed'
  | 'device_changed';

// THE ADOPTION CLAIM. An erasing adoption is not one write: the active day's play moves
// tuple by tuple BEFORE the identity transaction (see `accountLink.ts` for why that order
// is the recoverable one), and nothing in those moves says which adoption they belong to.
// Two devices on one unlinked account, each linking a DIFFERENT address at the same moment,
// would each move the tuples their own transfers reached first — splitting one day's play
// across two targets before only one of the two final transactions could win. And a bind on
// the source account, landing between the moves and the commit, would leave that account
// alive and reachable with its play already gone.
//
// So the source account is CLAIMED for one target first, on its own row, and every later
// step verifies the claim: the final delete conditions on it, and a bind refuses while one
// stands. A claim for the SAME target always passes — that is the player's own retry after
// a lost answer or a resent code — and a claim held by a different target refuses until it
// goes STALE (`LINK_CLAIM_SECONDS`), so an abandoned link cannot lock the account forever.
// The moves themselves do not re-check it: a transfer runs inside the request that took the
// claim, and the Lambda's whole lifetime is two orders of magnitude shorter than the window.
//   claimed           — this target holds the claim (fresh, renewed, or taken over stale);
//   claimed_elsewhere — another target's claim stands and is not stale;
//   account_changed   — the account is gone or carries an address (a bind won).
export type LinkClaimOutcome = 'claimed' | 'claimed_elsewhere' | 'account_changed';

// How long a claim binds the source account to one target with no commit. It only has to
// outlive the request that took it (the Lambda's timeout is seconds), and a code that could
// resume it lives this long anyway.
export const LINK_CLAIM_SECONDS = LINK_CODE_TTL_SECONDS;

// The claim's two attributes on the ACCOUNT row: the target, and when it was taken (epoch
// seconds — a Number, because a condition compares it arithmetically for staleness).
export const CLAIM_TO_ATTRIBUTE = 'linkTo';
export const CLAIM_AT_ATTRIBUTE = 'linkAt';

export function claimStaleBefore(now: string): number {
  return Math.floor(Date.parse(now) / 1_000) - LINK_CLAIM_SECONDS;
}

// One tuple of play that MOVES from the account being left to the one being adopted (#204's
// active-day transfer). It is the same triple for the round row and the score row, because
// both are addressed by (date, lang, mode) per player.
export interface LinkRoundMove {
  date: string;
  lang: string;
  mode: 'sentence' | 'word';
  // The game day, for the solved-day credit a transferred SENTENCE solve owes the adopting
  // account's streak. Absent when the moved round is not a solve.
  solvedDay?: number;
}

// The identity-bearing core of a link, committed as ONE transaction (see `adopt`).
export interface AccountAdoption {
  // The calling device's base item — the ONE row that moves, keyed by its token's hash.
  tokenHash: string;
  deviceId: string;
  // The account this device holds now, and the one it will hold. Equal is not a valid plan:
  // a no-op link never reaches here.
  from: string;
  to: string;
  // Whether `from` is being DELETED. False when it carries an email of its own — an account
  // that can be signed back into is not an orphan, so the device simply leaves it.
  erase: boolean;
  // The challenge this link consumed. Deleting it inside the transaction is what makes the
  // whole verification one-shot.
  emailHash: string;
  // The exact code that `verify` accepted. The consuming delete conditions on this digest,
  // so a re-send between verification and commit cannot swap in a challenge the caller did
  // not prove, and two final writes cannot both consume one code.
  codeHash: string;
  // A friend-merge job for the surviving account, present exactly when `erase` is.
  mergeFrom?: string;
  now: string;
}

export interface LinkStore {
  // Spend ALL send allowances as one decision, each over a ROLLING window of
  // `windowSeconds`. Returns false when any scope is at its bound and writes NONE of them,
  // so an IP refusal cannot burn the address's own budget.
  spendSends(
    allowances: readonly LinkSendAllowance[],
    windowSeconds: number,
    now: Date,
  ): Promise<boolean>;
  // Replace this address's pending challenge. A re-send always starts a fresh one: the
  // player is holding the newest mail, and leaving the old code alive would only widen the
  // guessing surface.
  putChallenge(emailHash: string, challenge: LinkChallenge): Promise<void>;
  // Check a code against the stored challenge, counting the attempt ATOMICALLY — the count
  // is the only thing standing between a 6-digit code and a guessing loop, so it may not be
  // a read-then-write.
  verify(emailHash: string, codeHash: string, now: Date): Promise<LinkVerifyResult>;
  // Which account an address reaches, or null when it reaches nobody.
  binding(emailHash: string): Promise<EmailBinding | null>;
  // BIND an unknown address to the caller's own account, and consume the challenge — the
  // simple half of a verified code, where nothing is left and nothing is destroyed. ONE
  // transaction of a CREATE-ONLY binding put, the account row's own email, and the
  // challenge delete. `taken` means another device won the race to this address between the
  // lookup and here; the route re-reads and adopts the account that won, which is the same
  // thing it would have done had the lookup seen it.
  bind(input: {
    emailHash: string;
    codeHash: string;
    email: string;
    accountId: string;
    now: string;
  }): Promise<LinkBindOutcome>;
  // CLAIM the source account for one target before its play moves — see `LinkClaimOutcome`.
  // Only an account with NO address can be claimed: the claim exists for the erasing
  // adoption, and an account that carries an address is never erased.
  claimAdoption(input: { from: string; to: string; now: string }): Promise<LinkClaimOutcome>;
  // The identity-bearing core, indivisible: consume the challenge, move the one device item,
  // delete the account being left (its account row AND its profile row, so no
  // identity-bearing read can dress a deleted player), and persist the friend-merge job.
  // An ERASING adoption deletes the source only while it holds the claim for `to`.
  //
  // It is ONE transaction because the half-states are not equally harmless: a device left on
  // a deleted account is a player signed out mid-link with everything gone, which is the one
  // outcome this flow may never produce.
  adopt(input: AccountAdoption): Promise<LinkAdoptOutcome>;
  // The accounts whose friends still have to be merged into this one. Normally empty; a
  // partially drained job is what makes it not.
  pendingMerges(accountId: string): Promise<string[]>;
  // The job is done. Idempotent — a job deleted twice is a job that finished twice.
  clearMerge(accountId: string, from: string): Promise<void>;
}

// What `adopt` mutates OUTSIDE its own key space — the device item, the account row and the
// profile row — declared HERE rather than on `DeviceStore`/`ProfileStore` because nothing in
// production calls them through a contract: `dynamoLinkStore` writes those items itself,
// inside the one transaction that makes them indivisible. The PROCESS-LOCAL store cannot
// reach another store's map, so the memory device and profile stores expose exactly these
// writes for it. A contract method no production store implements would be a contract lie;
// this pair says honestly that it exists for the in-memory implementation.
export interface LinkDeviceWrites {
  // The process-local equivalent of the production account-email condition: bind only
  // while the account exists, is still unlinked (or already carries this exact value), and
  // is not claimed by a live adoption.
  bindAccountEmail(accountId: string, email: string, now: string): boolean;
  // The process-local equivalent of the production claim condition (`LinkClaimOutcome`).
  claimAdoption(input: { from: string; to: string; now: string }): LinkClaimOutcome;
  // The process-local equivalent of the production adoption conditions. It validates the
  // device, both accounts and the erase/survive email state, then applies the device move
  // and optional account deletion synchronously inside the one owning map.
  adoptDevice(input: {
    tokenHash: string;
    deviceId: string;
    from: string;
    to: string;
    erase: boolean;
    now: string;
  }): 'adopted' | 'account_changed' | 'device_changed';
}

export interface LinkProfileWrites {
  // Delete the player's public row, so no identity-bearing read can dress a deleted
  // account (#204: "a missing profile must not fall back to a display identity").
  remove(publicId: string): void;
}

// The pending challenge for one address.
export function challengeKey(hash: string): string {
  return `link#${hash}`;
}
export const CHALLENGE_SORT_KEY = 'challenge';

// Which account an address reaches. Its own partition, so nothing else is ever read by the
// lookup that decides bind-or-adopt.
export function bindingKey(hash: string): string {
  return `email#${hash}`;
}
export const BINDING_SORT_KEY = 'email';

// A send allowance. `scope` names WHICH bound is being spent ("addr", "ip"), so the two
// counters can never collide on one item. The item holds the INSTANTS of the sends still
// inside the rolling window rather than a count: a count per fixed clock bucket admits two
// full allowances back to back across a bucket edge, which is not the bound the contract
// states. The list is bounded by the allowance itself (it is pruned on every write), and
// the write is optimistic — conditioned on the exact list it read — so two concurrent sends
// cannot both count against the same stale view.
export function sendKey(scope: string, hash: string): string {
  return `linksend#${scope}#${hash}`;
}
export const SEND_SORT_KEY = 'send';

// The sends that still count: those inside the window ending at `now`.
export function recentSends(sends: readonly number[], windowSeconds: number, now: Date): number[] {
  const since = now.getTime() - windowSeconds * 1_000;
  return sends.filter((at) => at > since);
}

// The friend-merge queue, partitioned by the SURVIVING account: the drain is "what still has
// to be merged into me", which is the question the adopting device's next call asks.
export function mergeKey(accountId: string): string {
  return `merge#${accountId}`;
}
export function mergeSortKey(from: string): string {
  return `from#${from}`;
}
export const MERGE_SORT_PREFIX = 'from#';
