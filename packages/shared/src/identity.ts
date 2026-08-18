// Player identity without accounts (#187): a random 128-bit SECRET the client generates
// on first need and keeps in localStorage. It is simultaneously the ID and the password —
// possession is the proof of ownership, so the server never registers or stores anything
// secret; it DERIVES the public identity from the secret on every authenticated call.
// Pasting the key on another device is the same identity (#188's designed backup
// affordance — its UI surface is not yet placed); losing localStorage loses it —
// accepted by design.
//
// This module lives in shared because the derivation is a cross-package contract: the WEB
// generates and sends the secret, the BACKEND turns it into the publicId every stored row
// is keyed by. Two implementations would drift into two identities for one key.

// The secret travels and stores as 32 lowercase hex characters (16 random bytes).
export const SECRET_PATTERN = /^[0-9a-f]{32}$/;

export function isValidSecret(value: unknown): value is string {
  return typeof value === 'string' && SECRET_PATTERN.test(value);
}

// Uses the Web Crypto API, which browsers and Node (>=19, Lambda's Node 22 included)
// expose on the same global — one implementation everywhere this package runs.
export function generateSecret(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// RFC 4648 base32, lowercased: compact, case-insensitive-safe, and free of characters a
// URL or a filename would ever need escaped (#188 will print publicIds).
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

// publicId = the first 10 bytes of SHA-256 over the secret's UTF-8 bytes, base32 — 80
// bits in exactly 16 characters (no padding). Truncation keeps it short enough to
// display while collisions stay out of reach for any real player population.
export const PUBLIC_ID_PATTERN = /^[a-z2-7]{16}$/;

export async function publicIdFromSecret(secret: string): Promise<string> {
  if (!isValidSecret(secret)) throw new Error('publicIdFromSecret: malformed secret');
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(secret),
  );
  const bytes = new Uint8Array(digest).subarray(0, 10);
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
