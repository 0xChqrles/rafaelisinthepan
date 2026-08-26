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
//   `linksend#<scope>#<hash>` / `send` — a send allowance with its own TTL (#169's counter
//                                        shape): one per address and one per address+IP.
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
  // A friend-merge job for the surviving account, present exactly when `erase` is.
  mergeFrom?: string;
  now: string;
}

export interface LinkStore {
  // Spend one send allowance. Returns false when the scope is over its bound for the
  // window; nothing is written then, so a refused send costs the caller nothing but the
  // request.
  spendSend(scope: string, hash: string, limit: number, windowSeconds: number, now: Date): Promise<boolean>;
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
    email: string;
    accountId: string;
    now: string;
  }): Promise<'bound' | 'taken'>;
  // The identity-bearing core, indivisible: consume the challenge, move the one device item,
  // delete the account being left (its account row AND its profile row, so no
  // identity-bearing read can dress a deleted player), and persist the friend-merge job.
  //
  // It is ONE transaction because the half-states are not equally harmless: a device left on
  // a deleted account is a player signed out mid-link with everything gone, which is the one
  // outcome this flow may never produce.
  adopt(input: AccountAdoption): Promise<void>;
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
  // Move the ONE device item to another account: the base key is the token's hash and does
  // not change — only the account it names and its index keys.
  reparentDevice(input: {
    tokenHash: string;
    deviceId: string;
    from: string;
    to: string;
    now: string;
  }): Promise<void>;
  // Record which address reaches this account, on the account row itself.
  bindAccountEmail(accountId: string, email: string, now: string): Promise<void>;
  // Delete the account row. Every device item still naming it stops authenticating, which
  // is the account-existence check `resolve` already makes.
  deleteAccount(accountId: string): Promise<void>;
}

export interface LinkProfileWrites {
  // Delete the player's public row, so no identity-bearing read can dress a deleted
  // account (#204: "a missing profile must not fall back to a display identity").
  remove(publicId: string): Promise<void>;
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

// A send allowance. `scope` names WHICH bound is being spent ("addr", "addrip"), so the two
// counters can never collide on one item — and the WINDOW is part of the key, so each one is
// a fresh item that starts at zero and expires on its own TTL. A single item with a stored
// window instant would have to be RESET when the window rolls, which is a read-then-write
// exactly where the count must not be raced; naming the window makes the whole thing one
// conditional `ADD`.
export function sendWindow(now: Date, windowSeconds: number): number {
  return Math.floor(now.getTime() / 1000 / windowSeconds);
}
export function sendKey(scope: string, hash: string, window: number): string {
  return `linksend#${scope}#${hash}#${window}`;
}
export const SEND_SORT_KEY = 'send';

// The friend-merge queue, partitioned by the SURVIVING account: the drain is "what still has
// to be merged into me", which is the question the adopting device's next call asks.
export function mergeKey(accountId: string): string {
  return `merge#${accountId}`;
}
export function mergeSortKey(from: string): string {
  return `from#${from}`;
}
export const MERGE_SORT_PREFIX = 'from#';
