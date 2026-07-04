// Share-card codec (issue #8): pack a solved result into a compact, URL-safe token so the
// whole result travels IN the share link — no database. The web encodes it into
// `…/s/<token>`; the backend decodes it to render the OG image + meta. Cross-runtime (pure
// JS, no Buffer/atob), so the SAME function runs in the browser and the Lambda.
//
// The card shows the puzzle's dayNumber (its stable ID), the score, and the row of colored
// squares — NEVER a local date: the backend owns the day (22:00-ET flip), so a calendar date
// would be wrong across timezones. The token therefore carries dayNumber, not a date.

// Byte layout (big-endian): [version:1][lang:2 ascii][dayNumber:2][score:2][n:1][pct*n].
// Each pct is a square's mean progress %, 0..100 in one byte. Total 8 + n bytes; base64url
// (unpadded) -> ~35 chars at the 18-square max.
const SHARE_VERSION = 1;
export const MAX_CARD_SQUARES = 18;

export interface ShareResult {
  lang: string; // 2-letter code (en / fr); drives the click-through redirect, not shown on the card
  dayNumber: number; // the puzzle's stable ID (server-owned day), shown as "#<dayNumber>"
  score: number; // unique tries
  squares: number[]; // per-square mean progress % (0..100) -> the colored rects
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64.length; i += 1) B64_LOOKUP[B64[i]] = i;

function bytesToB64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const rem = bytes.length - i;
    const b0 = bytes[i];
    const b1 = rem > 1 ? bytes[i + 1] : 0;
    const b2 = rem > 2 ? bytes[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (rem > 1) out += B64[((b1 & 0x0f) << 2) | (b2 >> 6)];
    if (rem > 2) out += B64[b2 & 0x3f];
  }
  return out;
}

function b64urlToBytes(s: string): Uint8Array | null {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i += 4) {
    const c0 = B64_LOOKUP[s[i]];
    const c1 = B64_LOOKUP[s[i + 1]];
    if (c0 === undefined || c1 === undefined) return null;
    bytes.push((c0 << 2) | (c1 >> 4));
    if (i + 2 < s.length) {
      const c2 = B64_LOOKUP[s[i + 2]];
      if (c2 === undefined) return null;
      bytes.push(((c1 & 0x0f) << 4) | (c2 >> 2));
      if (i + 3 < s.length) {
        const c3 = B64_LOOKUP[s[i + 3]];
        if (c3 === undefined) return null;
        bytes.push(((c2 & 0x03) << 6) | c3);
      }
    }
  }
  return new Uint8Array(bytes);
}

const clampU16 = (x: number) => Math.max(0, Math.min(0xffff, Math.round(x)));
const clampPct = (x: number) => Math.max(0, Math.min(100, Math.round(x)));

export function encodeResult(r: ShareResult): string {
  const sq = r.squares.slice(0, MAX_CARD_SQUARES).map(clampPct);
  const day = clampU16(r.dayNumber);
  const score = clampU16(r.score);
  const lang = (r.lang || '').padEnd(2, ' ');
  const bytes = new Uint8Array(8 + sq.length);
  bytes[0] = SHARE_VERSION;
  bytes[1] = lang.charCodeAt(0) & 0xff;
  bytes[2] = lang.charCodeAt(1) & 0xff;
  bytes[3] = day >> 8;
  bytes[4] = day & 0xff;
  bytes[5] = score >> 8;
  bytes[6] = score & 0xff;
  bytes[7] = sq.length;
  sq.forEach((p, i) => {
    bytes[8 + i] = p;
  });
  return bytesToB64url(bytes);
}

// Decode + validate. Returns null on ANY malformation (bad chars, wrong version, length
// mismatch, out-of-range pct/n) so a hand-crafted token can never make the renderer emit
// anything but numbers + colors from the fixed template.
export function decodeResult(token: string): ShareResult | null {
  const bytes = b64urlToBytes(token);
  if (!bytes || bytes.length < 8) return null;
  if (bytes[0] !== SHARE_VERSION) return null;
  const n = bytes[7];
  if (n > MAX_CARD_SQUARES || bytes.length !== 8 + n) return null;
  const lang = String.fromCharCode(bytes[1], bytes[2]).trim();
  const dayNumber = (bytes[3] << 8) | bytes[4];
  const score = (bytes[5] << 8) | bytes[6];
  const squares: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const p = bytes[8 + i];
    if (p > 100) return null;
    squares.push(p);
  }
  return { lang, dayNumber, score, squares };
}
