// Email account linking (#204): the address, and the 6-digit code that proves it.
//
// Email is the only identity primitive with zero comprehension cost for this audience —
// everyone has an address and everyone has clicked a "reset password" link. It is a CODE
// rather than a magic link because a link opens in whatever browser the mail client
// prefers (not the one that made the request) and corporate mail scanners prefetch links,
// consuming single-use tokens before the human ever taps. A code is also what a French
// bank asks for constantly, so it needs no explaining.
//
// This module is a cross-package contract. The WEB validates what it types before spending
// a send, and the BACKEND validates, NORMALIZES and hashes what it stores. Two spellings of
// the normalization would index ONE address as two accounts — the one failure this whole
// flow exists to prevent — so the pipeline lives here and both sides call it.

// RFC 5321's practical ceiling. Bounded so a hostile body cannot hand SES a megabyte.
export const EMAIL_MAX_LENGTH = 254;

// Deliberately PRAGMATIC, not RFC 5322: an unquoted 7-bit local part and one dotted ASCII
// domain with a 2+ letter final label. SES does not support SMTPUTF8, so accepting a Unicode
// local part would promise a code the configured sender can never deliver.
const EMAIL_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;
const EMAIL_LOCAL_MAX_LENGTH = 64;
const EMAIL_DOMAIN_MAX_LENGTH = 253;
const EMAIL_LABEL_MAX_LENGTH = 63;

// The canonical spelling of one address: trimmed, NFKC-normalized and LOWERCASED WHOLE.
//
// The local part is case-SENSITIVE per RFC 5321, and no provider a player uses treats it
// that way — so folding case is what makes `Bob@x.com` and `bob@x.com` the same account,
// which is what a person means when they type either. Nothing cleverer: no dot-stripping,
// no `+tag` folding. Those are Gmail rules, they are wrong everywhere else, and an address
// this function silently rewrote would send the code to a mailbox nobody named.
//
// Returns null when the value is not an address this game accepts — the ONE test both
// sides make, so a value the web let through can never be one the server refuses.
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().normalize('NFKC').toLowerCase();
  if (value.length === 0 || value.length > EMAIL_MAX_LENGTH) return null;
  if (!EMAIL_PATTERN.test(value)) return null;
  const at = value.indexOf('@');
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (
    local.length > EMAIL_LOCAL_MAX_LENGTH ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    domain.length > EMAIL_DOMAIN_MAX_LENGTH ||
    domain.split('.').some((label) => label.length > EMAIL_LABEL_MAX_LENGTH)
  ) {
    return null;
  }
  return value;
}

export function isValidEmail(raw: unknown): boolean {
  return normalizeEmail(raw) !== null;
}

// SIX digits, leading zeros kept — what a person reads out of a mail app and types back.
export const LINK_CODE_LENGTH = 6;
export const LINK_CODE_PATTERN = /^\d{6}$/;

export function isValidLinkCode(value: unknown): value is string {
  return typeof value === 'string' && LINK_CODE_PATTERN.test(value);
}

// How long a code stands. Long enough for a mail to arrive and be read on another device,
// short enough that a leaked one is worthless by the time it leaks.
export const LINK_CODE_TTL_SECONDS = 10 * 60;

// How many wrong codes one challenge tolerates before it is spent. A 6-digit code is one in
// a million per guess; five attempts is a person mistyping, and it is what keeps an
// unbounded guessing loop from ever reaching a meaningful fraction of that space.
export const LINK_CODE_MAX_ATTEMPTS = 5;

// The send allowances (#204's "or it is a free spam relay pointed at arbitrary inboxes"),
// enforced with the #169 HMAC-IP machinery. Per ADDRESS bounds what one inbox can be made to
// receive whoever asks; per IP bounds what one sender can spray across many. Both are
// counted over a ROLLING window ending at the request — never a fixed clock bucket, which
// admits two full allowances back to back across a bucket edge.
export const LINK_SEND_WINDOW_SECONDS = 60 * 60;
export const LINK_SENDS_PER_ADDRESS = 5;
export const LINK_SENDS_PER_IP = 20;
