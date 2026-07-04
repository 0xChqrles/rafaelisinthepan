// Share-card codec (issue #8): pack a solved result into a compact, URL-safe token so the
// whole result travels IN the share link — no database. The web encodes it into
// `…/s/<token>`; the backend decodes it to render the OG image + meta. Cross-runtime (pure
// JS), so the SAME function runs in the browser and the Lambda.
//
// The card shows the puzzle's dayNumber (its stable ID), the score, and the row of colored
// squares — NEVER a local date: the backend owns the day (22:00-ET flip), so a calendar date
// would be wrong across timezones.
//
// The payload is BIT-packed (not byte-aligned), then base64url'd, to keep the URL short:
//   version  4b | lang 2b | day 15b | scoreLen 4b | score <scoreLen>b | squares n×5b
// where n = squareCount(score) is DERIVED (not stored), and each square is the bucket's mean
// progress quantized to 5 bits (32 heat levels — visually identical to the on-screen grid).
// A perfect game packs to ~7 chars, an 18-square game to ~21.

const SHARE_VERSION = 1;

// --- how many squares (the SQUARE_BREAKPOINTS lookup) ------------------------------------
// Moved here from the web so the DECODER can derive the square count from the score (they
// are one and the same: squares.length === squareCount(score)). Minimum 3 (there are always
// 3 holes needing 3 distinct words), up to MAX_SQUARES. Half-open: `tries >= t`.
export const SQUARE_BREAKPOINTS = [4, 6, 10, 15, 22, 33, 48, 70, 100, 120, 150, 180, 215, 255, 300];
export const MIN_SQUARES = 3;
export const MAX_SQUARES = MIN_SQUARES + SQUARE_BREAKPOINTS.length; // 18

export function squareCount(tries: number): number {
  let m = MIN_SQUARES;
  for (const t of SQUARE_BREAKPOINTS) {
    if (tries >= t) m += 1;
    else break; // breakpoints ascend, so the first miss ends it
  }
  return m;
}

// --- field widths ------------------------------------------------------------------------
const VERSION_BITS = 4;
const LANG_BITS = 2; // room for 4 languages before a version bump
const DAY_BITS = 15; // days since ID_EPOCH -> ~89 years of headroom
const SCORE_LEN_BITS = 4; // holds the bit-length of the score (0..15)
const SCORE_MAX = 0x7fff; // 15-bit scores (32767) — far above any real game
const SQUARE_BITS = 5;
const QUANT_MAX = (1 << SQUARE_BITS) - 1; // 31 heat levels

// Store `dayNumber - ID_EPOCH` so the field stays small. ID_EPOCH is a fixed day index
// (days since 1970) BELOW the game's launch; day.ts's dayNumber is always >= this.
const ID_EPOCH = 20000; // ~2024-10-04, comfortably before launch

// Lang table — APPEND-ONLY (the index is stored). Unknown langs encode as 0 (en).
export const SHARE_LANGS = ['en', 'fr'];

export interface ShareResult {
  lang: string; // 2-letter code; drives the click-through redirect, not shown on the card
  dayNumber: number; // the puzzle's stable ID (server-owned day), shown as "#<dayNumber>"
  score: number; // unique tries
  squares: number[]; // per-square mean progress % (0..100) -> the colored rects
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// --- bit writer / reader (MSB-first) -----------------------------------------------------
class BitWriter {
  private bits: number[] = [];
  write(value: number, width: number): void {
    for (let i = width - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }
  toBytes(): Uint8Array {
    const bytes = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => {
      if (b) bytes[i >> 3] |= 1 << (7 - (i & 7));
    });
    return bytes;
  }
}

class BitReader {
  private pos = 0;
  constructor(private readonly bytes: Uint8Array) {}
  read(width: number): number {
    let v = 0;
    for (let i = 0; i < width; i += 1) {
      const bytePos = this.pos >> 3;
      if (bytePos >= this.bytes.length) throw new Error('bit overrun');
      v = (v << 1) | ((this.bytes[bytePos] >> (7 - (this.pos & 7))) & 1);
      this.pos += 1;
    }
    return v >>> 0;
  }
  get remainingBits(): number {
    return this.bytes.length * 8 - this.pos;
  }
}

// --- base64url over bytes (env-agnostic: no Buffer/atob) ---------------------------------
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

// bit length of a non-negative integer (0 -> 0).
const bitLength = (x: number) => (x <= 0 ? 0 : 32 - Math.clz32(x));

export function encodeResult(r: ShareResult): string {
  const w = new BitWriter();
  w.write(SHARE_VERSION, VERSION_BITS);
  w.write(Math.max(0, SHARE_LANGS.indexOf(r.lang)), LANG_BITS); // unknown -> 0 (en)
  w.write(clamp(Math.round(r.dayNumber) - ID_EPOCH, 0, (1 << DAY_BITS) - 1), DAY_BITS);

  const score = clamp(Math.round(r.score), 0, SCORE_MAX);
  const scoreLen = bitLength(score);
  w.write(scoreLen, SCORE_LEN_BITS);
  w.write(score, scoreLen);

  // The square COUNT is derived from the score, so we emit exactly that many, quantizing
  // each mean progress % to 5 bits (0..31). (r.squares should already be this length.)
  const n = squareCount(score);
  for (let i = 0; i < n; i += 1) {
    const pct = clamp(Math.round(r.squares[i] ?? 0), 0, 100);
    w.write(Math.round((pct / 100) * QUANT_MAX), SQUARE_BITS);
  }
  return bytesToB64url(w.toBytes());
}

// Decode + validate. Returns null on ANY malformation (bad chars, wrong version, overrun,
// leftover bytes) so a hand-crafted token can never make the renderer emit anything but
// numbers + colors from the fixed template.
export function decodeResult(token: string): ShareResult | null {
  const bytes = b64urlToBytes(token);
  if (!bytes) return null;
  try {
    const rd = new BitReader(bytes);
    if (rd.read(VERSION_BITS) !== SHARE_VERSION) return null;
    const lang = SHARE_LANGS[rd.read(LANG_BITS)];
    if (!lang) return null;
    const dayNumber = rd.read(DAY_BITS) + ID_EPOCH;
    const scoreLen = rd.read(SCORE_LEN_BITS);
    const score = scoreLen === 0 ? 0 : rd.read(scoreLen);

    const n = squareCount(score);
    const squares: number[] = [];
    for (let i = 0; i < n; i += 1) squares.push((rd.read(SQUARE_BITS) / QUANT_MAX) * 100);

    // Only the final byte's padding bits (0..7) may remain; a whole extra byte means the
    // token was tampered/extended.
    if (rd.remainingBits >= 8) return null;
    return { lang, dayNumber, score, squares };
  } catch {
    return null; // bit overrun (truncated token)
  }
}
