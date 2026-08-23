// Device identity (#216) — what a device HOLDS, and what the server ASSIGNS it.
//
// Until #216 the identity WAS a 128-bit secret in localStorage (#187), and the account id
// was derived from it on the client. Every device that reached an account held that same
// secret, so nothing was device-specific and nothing could be revoked: the only remedy for
// a leaked account was to abandon it — losing the archive, the streak and every friend.
// A device now holds its own REVOCABLE token, and the account id is assigned by the server.
//
// This module is a cross-package contract. The WEB mints the token and sends it; the
// BACKEND validates it, hashes it, and reads the ONE device item keyed by that hash. Two
// spellings of the token's shape would fork one device into two — or, worse, admit a
// non-canonical value that keys a different row.
//
// The CLIENT never hashes to derive identity any more: that removes `crypto.subtle` from
// paths that need no identity, including an anonymous global-board read. Live POSTs still
// hash their exact body for the OAC contract (`web/src/api.ts`), so an insecure context
// cannot bootstrap. Token minting uses `crypto.getRandomValues`, which is available there;
// token hashing is the server's (`backend/src/deviceStore.ts`).
//
// `assigned.ts` is untouched: it keeps deriving the pseudonym and the mark from the account
// id, which is why a server-assigned id keeps the exact shape a derived one had.

// The RAW device token: 32 random bytes as exactly 64 LOWERCASE hex characters. The server
// accepts only this spelling and never normalizes an uppercase one, so one token has one
// hash and one row.
export const DEVICE_TOKEN_BYTES = 32;
export const DEVICE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export function isValidDeviceToken(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_TOKEN_PATTERN.test(value);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Uses the Web Crypto API, which browsers and Node (>=19, Lambda's Node 22 included)
// expose on the same global — one implementation everywhere this package runs.
export function generateDeviceToken(): string {
  const bytes = new Uint8Array(DEVICE_TOKEN_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return hex(bytes);
}

// RFC 4648 base32, lowercased: compact, case-insensitive-safe, and free of characters a
// URL or a filename would ever need escaped (an invite link IS a publicId, #189).
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

// 80 bits in exactly 16 characters (no padding) — short enough to display, with collisions
// out of reach for any real player population.
const ID_BYTES = 10;

export const PUBLIC_ID_PATTERN = /^[a-z2-7]{16}$/;
// A device id is the same shape as an account id and read in exactly the same places (a
// body field, a GSI sort key), so it is the same rule rather than a second one.
export const DEVICE_ID_PATTERN = PUBLIC_ID_PATTERN;

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

function randomId(): string {
  const bytes = new Uint8Array(ID_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return base32(bytes);
}

// The ACCOUNT id — server-assigned since #216, where it used to be SHA-256 over the
// client's secret. It is public by design (an invite link carries one) and it is what
// `assigned.ts` derives a player's pseudonym and mark from, so its shape is unchanged.
export function generatePublicId(): string {
  return randomId();
}

// The DEVICE id — the handle the sign-out screen lists and revokes by. It never
// authenticates anything: the token does, and the token is never stored server-side.
export function generateDeviceId(): string {
  return randomId();
}
