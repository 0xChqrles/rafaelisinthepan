// A DAY PREVIEW CODE (user-decided 2026-10-08): what lets the operator play a FUTURE day
// early, on its real round. The code is signed here and nowhere else — shared holds only its
// name on the wire and its shape (shared preview.ts) — so only the holder of the server
// secret can mint one, and one code grants exactly one (lang, date).
//
// Keyed by the SAME secret as the #169 address hashes and the #204 link codes
// (`ipHmacSecret`), kept apart from both by its `preview:` prefix: nothing new to provision,
// and rotating that secret voids every code already sent. The message cannot be ambiguous —
// a language is two letters and a date has one fixed form.
import { createHmac } from 'node:crypto';
import { isPreviewCode } from '@whippin/shared';
import { sameDigest } from './linkStore';

// The first 16 hex characters (64 bits) of the HMAC: short enough for a link, far past
// guessing — and a wrong guess costs a refused 404 that never reaches the store.
export function previewCode(secret: string, lang: string, date: string): string {
  return createHmac('sha256', secret).update(`preview:${lang}:${date}`).digest('hex').slice(0, 16);
}

// Whether `code` is this (lang, date)'s, compared in constant time. The shape check runs
// first, so a malformed value (non-hex, uppercase, any other length, non-ASCII) is refused
// before the comparison ever sees it.
export function previewCodeMatches(secret: string, lang: string, date: string, code: string): boolean {
  if (!isPreviewCode(code)) return false;
  return sameDigest(code, previewCode(secret, lang, date));
}
