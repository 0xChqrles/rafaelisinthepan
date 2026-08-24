// Devices and the accounts they belong to (#216).
//
// A device holds a raw token; the store holds `SHA-256(token)` and never the token itself.
// The hash is deterministic, so AUTHENTICATION is one direct base-table read — no index, no
// scan — and the server stores nothing that can authenticate. Revocation deletes that one
// base item, which is what makes signing a device out possible WITHOUT holding it.
//
// ONE item per device supports both access patterns:
//
//   base key  `device#<tokenHash>` / `device`   — token -> device -> account, every call
//   GSI       `account#<accountId>` / `device#<deviceId>` — the account's devices, for the
//                                                           sign-out screen
//
// The security-sensitive path is the BASE item: `resolve` reads it directly and then
// requires its account row still to exist. The GSI may briefly lag a create or a delete —
// a cosmetic device-list delay only — and it can never keep a revoked token authenticable,
// because the token's own item is gone. The account-existence check is the backstop for the
// reverse: deleting an account rejects any device item an eventually-consistent enumeration
// happened to miss.
//
// The ACCOUNT row lives in this contract rather than one of its own because BOOTSTRAP
// writes both in a single transaction: an account with no device is unreachable and a
// device with no account is unauthenticable, so a half-written pair is not a state either
// side should have to handle.

import { createHash } from 'node:crypto';

// What the base item is keyed by. SHA-256 is deterministic, so authentication stays ONE
// direct read; and because only the digest is stored, a dump of this table authenticates
// nobody. The token is validated against its canonical spelling BEFORE it reaches here —
// never normalized — so one token has exactly one hash and one row. The raw token is never
// logged and never leaves the request that carried it.
export function deviceTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// What a device IS, in the words a person recognises. Parsed SERVER-side from the
// `User-Agent` header (`userAgent.ts`) — the client can lie and the server sees the header
// anyway — and stored as FIELDS rather than a formatted string, so the UI can render icons
// and change its wording without a migration. Every field may be empty: a UA that says
// nothing recognisable is labelled by the screen, never guessed at here.
export interface DeviceAgent {
  // The hardware family a person names: "iPhone", "Android", "Mac", "Windows", "Linux".
  device: string;
  // The operating system, when the UA distinguishes it from the family ("iOS 17").
  os: string;
  // The browser: "Chrome", "Safari", "Firefox", "Edge", "Samsung Internet".
  browser: string;
}

export interface DeviceRecord {
  // Opaque, non-authenticating handle for the ONE base item. It is SHA-256(token), exposed
  // only to this account's device list so a later revocation can address the base table
  // directly instead of trying to rediscover it through an eventually-consistent GSI.
  revokeKey: string;
  deviceId: string;
  accountId: string;
  agent: DeviceAgent;
  createdAt: string;
  lastSeenAt: string;
}

export interface AccountRecord {
  accountId: string;
  createdAt: string;
}

// What an authenticated call resolves to: the calling device and the live account it acts
// as. Both, or neither — a device whose account row is gone is `unknown_device` like a
// device whose own item is gone.
export interface ResolvedDevice {
  device: DeviceRecord;
  account: AccountRecord;
}

export interface BootstrapInput {
  tokenHash: string;
  // Both ids are minted by the CALLER of the store (the route), from `@whippin/shared`, so
  // the store stays a storage contract and the id format has one spelling.
  accountId: string;
  deviceId: string;
  agent: DeviceAgent;
  now: string;
}

// A failed conditional delete has two materially different meanings. `absent` is a
// successful idempotent sign-out whose row may still be visible through the lagging GSI;
// `mismatch` is a forged/stale handle that must not hide the live row it actually names.
export type RevokeResult = 'removed' | 'absent' | 'mismatch';

export interface DeviceStore {
  // AUTHENTICATION. One direct read of the base item, then the account-existence check.
  resolve(tokenHash: string): Promise<ResolvedDevice | null>;
  // BOOTSTRAP — idempotent by token hash: a lost answer after a committed write must
  // return the device/account already created rather than mint another identity.
  bootstrap(input: BootstrapInput): Promise<ResolvedDevice>;
  // The sign-out screen's list, off the GSI. Eventually consistent by nature.
  list(accountId: string): Promise<DeviceRecord[]>;
  // REVOCATION: delete the ONE base item by the opaque key returned in the device list.
  // The account + display id remain a condition on that direct delete, so a forged or stale
  // key can never remove somebody else's device. The result distinguishes an already-gone
  // target from an ownership mismatch so the route can correct eventual GSI lag safely.
  revoke(accountId: string, deviceId: string, revokeKey: string): Promise<RevokeResult>;
  // Move `lastSeenAt` forward. Called at most once per device per DAY (see `staleLastSeen`),
  // because this rides every authenticated call and the round route writes once a second.
  touch(tokenHash: string, now: string): Promise<void>;
}

// The device item's own partition — keyed by the token's hash, never the token.
export function deviceKey(tokenHash: string): string {
  return `device#${tokenHash}`;
}

export const DEVICE_SORT_KEY = 'device';

// The GSI's keys. The account partition is the player's own `player#<id>` prefix so a
// human reading the table sees one account's rows together; the sort key is prefixed too,
// so the index has room for a second per-account row shape without ambiguity.
export function deviceIndexKey(accountId: string): string {
  return `player#${accountId}`;
}

export function deviceIndexSortKey(deviceId: string): string {
  return `device#${deviceId}`;
}

// The account item shares the player's partition with the #188 profile row, under its own
// sort key: one Query on `player#<id>` shows everything an account is.
export function accountKey(accountId: string): string {
  return `player#${accountId}`;
}

export const ACCOUNT_SORT_KEY = 'account';

// The name of the sparse index the device rows carry. Only items holding BOTH index keys
// are in it, which is every device row and nothing else on this table.
export const DEVICE_INDEX_NAME = 'DeviceByAccount';

// Is this device's `lastSeenAt` from an earlier DAY than now? `lastSeenAt` is what makes
// the sign-out screen legible ("this one, last used yesterday"), and it rides EVERY
// authenticated call — including `/round`'s, which a player fires about once a second while
// typing. Refreshing it per request would double that route's writes for a value nobody
// reads at that resolution, so it moves at most once a day per device. The comparison is
// free: the item was just read for authentication.
export function staleLastSeen(lastSeenAt: string, now: string): boolean {
  return lastSeenAt.slice(0, 10) !== now.slice(0, 10);
}
