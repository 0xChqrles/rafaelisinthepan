// Share-card codec (issue #8): pack a solved result into a compact, URL-safe token so the
// whole result travels IN the share link — no database. The web encodes it into
// `…/s/<token>`; the backend decodes it to render the OG image + meta. Cross-runtime (pure
// JS), so the SAME function runs in the browser and the Lambda.
//
// The TOKEN stores the puzzle's dayNumber (its stable, server-owned ID), never a date: the
// backend owns the day (22:00-ET flip), so packing the SHARER's local date would be wrong
// across timezones. The card DISPLAYS that index as the one calendar date it is
// (`dateForDayNumber`, its exact inverse — decided 2026-08-03), which is timezone-free and
// the same day the shared link resolves to.
//
// **v2 (decided 2026-07-25)** carries the RAW run instead of the bucketed squares, so the
// card draws the same ruler the solved screen does: one cell per counted try, plus a tick
// where each secret dropped. v1 tokens (bucketed squares) decode to `null` — the payloads
// are incompatible, and an old link is better 404'd than mis-drawn. The share text's emoji
// row went raw with it (one emoji per try, same ramp), so the bounded 3..18 bucketed row and
// its whole square-count curve are gone from the codebase.
//
// The payload is BIT-packed (not byte-aligned), then base64url'd, to keep the URL short:
//   version 4b | lang 2b | day 15b | scoreLen 4b | score <scoreLen>b
//   run    score × ( 1b: 1 = same % as the previous try | 0 = +5b quantized % )
//   ticks  3b count, then count × ( 1b: 1 = +<bits(score)>b solving try | 0 = never solved )
// The run's cell count is DERIVED from the score (they are the same number), and the repeat
// bit is what keeps a long game's link short: reconstruction only moves on an IMPROVING
// guess, and a long game is long precisely because most of its guesses don't improve.
// A perfect game packs to ~11 chars, a typical dozen-try game to ~15.

const SHARE_VERSION = 2;

// Word mode's token (#156) lives in the SAME version namespace — the version field is a
// FORMAT id, and the word result is a different format: no trajectory or ticks — the
// common `version | lang | day` opening, ONE claim count PER RARITY GRADE (v5, decided
// 2026-08-11: the share surfaces break the score down by rarity, and the OG card renders
// from the token alone, so the breakdown must travel in it; the total claim count is
// DERIVED as the counts' sum, never stored, so the two can never disagree), then the
// day's UTF-8 DISPLAY word. The card needs that word to reproduce the game's blue
// terminus while remaining content-addressed by the token (no puzzle-store lookup on an
// OG request). v3 (score only) and v4 (score + word, no breakdown) are retired; a future
// sentence-format bump must skip all three ids. decodeLegacyShareTarget's "strictly older
// than the sentence version" rule keeps rejecting them, so a superseded or malformed Word
// token still 404s rather than earning a redirect.
const WORD_SHARE_VERSION = 5;

// How many rarity counts a word token carries — the web's ladder order, commonest first
// (COMMON..ARCANE). The COUNT of grades is this codec's contract; what a grade MEANS
// (its name, threshold, colour) stays the consumers' own tuning.
export const WORD_RARITY_GRADES = 5;

// --- field widths ------------------------------------------------------------------------
const VERSION_BITS = 4;
const LANG_BITS = 2; // room for 4 languages before a version bump
const DAY_BITS = 15; // days since ID_EPOCH -> ~89 years of headroom
const SCORE_LEN_BITS = 4; // holds the bit-length of the score (0..15)
const SCORE_MAX = 0x7fff; // 15-bit scores (32767) — far above any real game
const WORD_LEN_BITS = 8; // UTF-8 bytes; 255 comfortably covers any generated display word
const WORD_MAX_BYTES = (1 << WORD_LEN_BITS) - 1;
const CELL_BITS = 5;
const QUANT_MAX = (1 << CELL_BITS) - 1; // 31 reconstruction levels
const TICK_COUNT_BITS = 3; // a puzzle has 3 distinct secrets; 0..7 leaves headroom
const MAX_TICKS = (1 << TICK_COUNT_BITS) - 1;

// Store `dayNumber - ID_EPOCH` so the field stays small. ID_EPOCH is a fixed day index
// (days since 1970) BELOW the game's launch; day.ts's dayNumber is always >= this.
const ID_EPOCH = 20000; // ~2024-10-04, comfortably before launch

// Lang table — APPEND-ONLY (the index is stored). Unknown langs encode as 0 (en).
export const SHARE_LANGS = ['en', 'fr'];

export interface ShareResult {
  lang: string; // 2-letter code; drives the click-through redirect, not shown on the card
  dayNumber: number; // the puzzle's stable ID (server-owned day), shown as its calendar date
  score: number; // unique tries — ALSO the ruler's cell count (one cell per counted try)
  trajectory: number[]; // reconstruction % (0..100) after each counted try -> the bar's cells
  // Per DISTINCT secret, in sentence order (so the index IS the number under the tick): the
  // 1-based try that dropped it, or null when the run never did (an unfinished run).
  solvedAt: (number | null)[];
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

// A reconstruction % (0..100) <-> its 5-bit level.
const quant = (pct: number) => Math.round((clamp(pct, 0, 100) / 100) * QUANT_MAX);
const dequant = (level: number) => (level / QUANT_MAX) * 100;

// The Word display form is interpolated into XML after escaping markup characters. Reject
// control/surrogate/noncharacter scalars that XML 1.0 cannot represent at all, so a forged
// but otherwise well-packed token still fails flat instead of reaching the rasterizer as a
// malformed document. Generated words are ordinary letters/marks/dashes and pass unchanged.
function isXmlText(value: string): boolean {
  if (value.length === 0) return false;
  return Array.from(value).every((char) => {
    const cp = char.codePointAt(0)!;
    return (
      (cp >= 0x20 && cp <= 0xd7ff) ||
      (cp >= 0xe000 && cp <= 0xfffd) ||
      (cp >= 0x10000 && cp <= 0x10ffff)
    );
  });
}

export function encodeResult(r: ShareResult): string {
  const w = new BitWriter();
  w.write(SHARE_VERSION, VERSION_BITS);
  w.write(Math.max(0, SHARE_LANGS.indexOf(r.lang)), LANG_BITS); // unknown -> 0 (en)
  w.write(clamp(Math.round(r.dayNumber) - ID_EPOCH, 0, (1 << DAY_BITS) - 1), DAY_BITS);

  const score = clamp(Math.round(r.score), 0, SCORE_MAX);
  const scoreLen = bitLength(score);
  w.write(scoreLen, SCORE_LEN_BITS);
  w.write(score, scoreLen);

  // The RUN: exactly `score` cells (the count is derived from the score, not stored), each
  // the reconstruction % after that try quantized to 5 bits (0..31). A try that did not move
  // the reconstruction costs ONE bit — which is what keeps a long game's link short.
  // (r.trajectory should already have `score` entries; a short one holds its last value.)
  let prev = 0; // quantized reconstruction before any guess — a fresh board sits at 0
  for (let i = 0; i < score; i += 1) {
    const q = i < r.trajectory.length ? quant(r.trajectory[i]) : prev;
    if (q === prev) {
      w.write(1, 1);
    } else {
      w.write(0, 1);
      w.write(q, CELL_BITS);
      prev = q;
    }
  }

  // The TICKS: one entry per distinct secret, in sentence order (so its index IS the number
  // the card stacks under the tick). A tick's try is 1..score, which fits the score's own
  // bit length. With NO tries there is no try to point at, so every tick encodes as
  // "never solved" — the decoder rejects a tick outside 1..score, and the codec's contract
  // is that anything it writes it can read back.
  const ticks = r.solvedAt.slice(0, MAX_TICKS);
  const idxBits = bitLength(Math.max(1, score));
  w.write(ticks.length, TICK_COUNT_BITS);
  for (const at of ticks) {
    if (at == null || score === 0) {
      w.write(0, 1);
    } else {
      w.write(1, 1);
      w.write(clamp(Math.round(at), 1, score), idxBits);
    }
  }
  return bytesToB64url(w.toBytes());
}

// --- Word mode (#156) ---------------------------------------------------------------------
// One daily word, claims until the clock dies: the gameplay result is the CLAIM COUNT
// BROKEN DOWN BY RARITY GRADE, followed by the day's display word solely so the OG card can
// reproduce the public blue terminus. Encoded/decoded by its own pair rather than a mode
// bit inside the sentence token, so neither format pays for the other's fields.
export interface WordShareResult {
  lang: string; // 2-letter code; drives the click-through redirect (/<lang>/word/<date>)
  dayNumber: number; // the puzzle's stable ID (server-owned day), shown as its calendar date
  counts: readonly number[]; // claims per rarity grade, commonest first (WORD_RARITY_GRADES entries)
  word: string; // accented display form — never the slug
}

// The claim count IS the counts' sum — derived wherever a surface names it, never stored,
// so the headline and the breakdown cannot disagree.
export function wordShareScore(counts: readonly number[]): number {
  return counts.reduce((sum, n) => sum + n, 0);
}

export function encodeWordResult(r: WordShareResult): string {
  if (r.counts.length !== WORD_RARITY_GRADES) {
    throw new RangeError(`Word share carries exactly ${WORD_RARITY_GRADES} rarity counts.`);
  }
  const w = new BitWriter();
  w.write(WORD_SHARE_VERSION, VERSION_BITS);
  w.write(Math.max(0, SHARE_LANGS.indexOf(r.lang)), LANG_BITS); // unknown -> 0 (en)
  w.write(clamp(Math.round(r.dayNumber) - ID_EPOCH, 0, (1 << DAY_BITS) - 1), DAY_BITS);
  // Each count in the score field's own variable-length scheme: a grade the run never
  // claimed costs 4 bits, so the common case (a couple of grades hit) stays short.
  for (const raw of r.counts) {
    const count = clamp(Math.round(raw), 0, SCORE_MAX);
    const len = bitLength(count);
    w.write(len, SCORE_LEN_BITS);
    w.write(count, len);
  }

  const word = new TextEncoder().encode(r.word);
  if (!isXmlText(r.word) || word.length > WORD_MAX_BYTES) {
    throw new RangeError(`Word share display form must occupy 1..${WORD_MAX_BYTES} UTF-8 bytes.`);
  }
  w.write(word.length, WORD_LEN_BITS);
  for (const byte of word) w.write(byte, 8);
  return bytesToB64url(w.toBytes());
}

// Decode + validate a word-mode token. Null on ANY malformation (bad chars, wrong
// version, overrun, leftover bytes), the same flat refusal the sentence decoder gives —
// its only free text is length-bounded, valid UTF-8/XML and escaped by the SVG renderer.
export function decodeWordResult(token: string): WordShareResult | null {
  const bytes = b64urlToBytes(token);
  if (!bytes) return null;
  try {
    const rd = new BitReader(bytes);
    if (rd.read(VERSION_BITS) !== WORD_SHARE_VERSION) return null;
    const lang = SHARE_LANGS[rd.read(LANG_BITS)];
    if (!lang) return null;
    const dayNumber = rd.read(DAY_BITS) + ID_EPOCH;
    const counts: number[] = [];
    for (let i = 0; i < WORD_RARITY_GRADES; i += 1) {
      const len = rd.read(SCORE_LEN_BITS);
      counts.push(len === 0 ? 0 : rd.read(len));
    }
    const wordLength = rd.read(WORD_LEN_BITS);
    if (wordLength === 0) return null;
    const wordBytes = new Uint8Array(wordLength);
    for (let i = 0; i < wordLength; i += 1) wordBytes[i] = rd.read(8);
    const word = new TextDecoder('utf-8', { fatal: true }).decode(wordBytes);
    if (!isXmlText(word)) return null;
    // Only the final byte's padding bits (0..7) may remain.
    if (rd.remainingBits >= 8) return null;
    return { lang, dayNumber, counts, word };
  } catch {
    return null; // bit overrun (truncated token)
  }
}

// Every version so far opens with the SAME header — `version | lang | day | scoreLen |
// score` — and only the payload after it differs. That is what lets an OLD link stay
// useful: a v1 token can't feed the v2 ruler, but its language and day are right there, so
// `/s/<v1token>` can send the reader to the day they were shown instead of a dead end.
//
// STRICTLY older versions only. A CURRENT-version token that `decodeResult` rejected is
// malformed, not legacy, and must keep 404-ing — otherwise a hand-crafted token would earn
// a redirect instead of the flat refusal the codec promises.
export interface LegacyShareTarget {
  version: number;
  lang: string;
  dayNumber: number;
}

export function decodeLegacyShareTarget(token: string): LegacyShareTarget | null {
  const bytes = b64urlToBytes(token);
  if (!bytes) return null;
  try {
    const rd = new BitReader(bytes);
    const version = rd.read(VERSION_BITS);
    if (version < 1 || version >= SHARE_VERSION) return null;
    const lang = SHARE_LANGS[rd.read(LANG_BITS)];
    if (!lang) return null;
    return { version, lang, dayNumber: rd.read(DAY_BITS) + ID_EPOCH };
  } catch {
    return null; // bit overrun (truncated token)
  }
}

// Decode + validate. Returns null on ANY malformation (bad chars, wrong version, overrun,
// leftover bytes, an out-of-range tick) so a hand-crafted token can never make the renderer
// emit anything but numbers + colors from the fixed template. A v1 token fails the version
// check like any other stranger — its bucketed squares can't feed a per-try ruler; the
// backend falls back to `decodeLegacyShareTarget` to redirect it rather than 404 the reader.
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

    // One cell per counted try, each carrying the previous level forward unless the try
    // improved it. A forged long score simply overruns the bits and returns null below.
    const trajectory: number[] = [];
    let level = 0;
    for (let i = 0; i < score; i += 1) {
      if (rd.read(1) === 0) level = rd.read(CELL_BITS);
      trajectory.push(dequant(level));
    }

    const idxBits = bitLength(Math.max(1, score));
    const tickCount = rd.read(TICK_COUNT_BITS);
    const solvedAt: (number | null)[] = [];
    for (let i = 0; i < tickCount; i += 1) {
      if (rd.read(1) === 0) {
        solvedAt.push(null);
        continue;
      }
      const at = rd.read(idxBits);
      if (at < 1 || at > score) return null; // a tick must land on a real try
      solvedAt.push(at);
    }

    // Only the final byte's padding bits (0..7) may remain; a whole extra byte means the
    // token was tampered/extended.
    if (rd.remainingBits >= 8) return null;
    return { lang, dayNumber, score, trajectory, solvedAt };
  } catch {
    return null; // bit overrun (truncated token)
  }
}
