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
// its square-count curve are gone from the CODEC — the token carries the raw run, so nothing
// here derives a cell count (the bounded row itself lives on in web/src/game/share.ts, which
// summarises the same bar for a text message).
//
// **v6 (#214)** adds the CAPPED flag: a round the server refused further appends to at
// `ROUND_GUESS_CAP`, unsolved, ends at `∞` instead of a try count. The numeric score stays
// in the token — it is still the ruler's cell count, and the ruler is still one cell per
// canonical try, never 500 raw storage entries — so the flag changes only what the HEADLINE
// says. A capped token carries NO solve ticks: the run never finished, and the result the
// card draws is the reconstruction it reached. v3–v5 were the retired Word mode's ids in
// this one namespace, so the sentence format went from 2 to 6.
//
// The payload is BIT-packed (not byte-aligned), then base64url'd, to keep the URL short:
//   version 4b | lang 2b | day 15b | capped 1b | scoreLen 4b | score <scoreLen>b
//   run    score × ( 1b: 1 = same % as the previous try | 0 = +5b quantized % )
//   ticks  (uncapped only) 3b count, then count × ( 1b: 1 = +<bits(score)>b try | 0 = never )
// The run's cell count is DERIVED from the score (they are the same number), and the repeat
// bit is what keeps a long game's link short: reconstruction only moves on an IMPROVING
// guess, and a long game is long precisely because most of its guesses don't improve.
// A perfect game packs to ~11 chars, a typical dozen-try game to ~15.
//
// **v7 (2026-09-24)** is a BONUS puzzle's result (`bonus.ts`): the same payload after a
// header that names the bonus instead of a day —
//   version 4b | lang 2b | bonusId 24b | …the v6 payload…
// A bonus is no day, so a v7 result carries NO `dayNumber`: every consumer that counts a
// day (the WhatsApp bot's podium) has to see it is not one.

import { BONUS_ID_MAX, BONUS_ID_MIN } from './bonus';

const SHARE_VERSION = 6;
const BONUS_SHARE_VERSION = 7;

// The RETIRED sentence formats — the ones `decodeLegacyShareTarget` still recovers a
// language and a day from. Named EXPLICITLY rather than as "anything older than the
// current version" (#214): v3–v5 were the retired Word mode's ids, and a range test would
// hand one of those old links the redirect the codec promises to refuse — it stays a flat
// 404.
const LEGACY_SENTENCE_VERSIONS: readonly number[] = [1, 2];

// --- field widths ------------------------------------------------------------------------
const VERSION_BITS = 4;
const LANG_BITS = 2; // room for 4 languages before a version bump
const DAY_BITS = 15; // days since ID_EPOCH -> ~89 years of headroom
const BONUS_ID_BITS = 24; // a seven-digit bonus id (<= 9 999 999 < 2^24)
const SCORE_LEN_BITS = 4; // holds the bit-length of the score (0..15)
const SCORE_MAX = 0x7fff; // 15-bit scores (32767) — far above any real game
const CELL_BITS = 5;
const QUANT_MAX = (1 << CELL_BITS) - 1; // 31 reconstruction levels
const TICK_COUNT_BITS = 3; // a puzzle has 3 distinct secrets; 0..7 leaves headroom
const MAX_TICKS = (1 << TICK_COUNT_BITS) - 1;

// Store `dayNumber - ID_EPOCH` so the field stays small. ID_EPOCH is a fixed day index
// (days since 1970) BELOW the game's launch; day.ts's dayNumber is always >= this.
const ID_EPOCH = 20000; // ~2024-10-04, comfortably before launch

// Lang table — APPEND-ONLY (the index is stored). Unknown langs encode as 0 (en).
const SHARE_LANGS = ['en', 'fr'];

export interface ShareResult {
  lang: string; // 2-letter code; drives the click-through redirect, not shown on the card
  // WHICH PUZZLE — exactly one of the two: a daily's stable ID (server-owned day, shown as
  // its calendar date), or a BONUS puzzle's id (v7). A consumer that counts days must
  // check `dayNumber` is there: a bonus is no day.
  dayNumber?: number;
  bonusId?: number;
  score: number; // unique tries — ALSO the ruler's cell count (one cell per counted try)
  trajectory: number[]; // reconstruction % (0..100) after each counted try -> the bar's cells
  // Per DISTINCT secret, in sentence order (so the index IS the number under the tick): the
  // 1-based try that dropped it, or null when the run never did (an unfinished run).
  solvedAt: (number | null)[];
  // The round hit `ROUND_GUESS_CAP` unsolved (#214): every surface says `∞` where it would
  // say the count. The score still travels — it is the ruler's length — and a capped run
  // carries no ticks, so this decodes with an empty `solvedAt`.
  capped?: boolean;
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

export function encodeResult(r: ShareResult): string {
  const w = new BitWriter();
  const bonus = r.bonusId !== undefined;
  w.write(bonus ? BONUS_SHARE_VERSION : SHARE_VERSION, VERSION_BITS);
  w.write(Math.max(0, SHARE_LANGS.indexOf(r.lang)), LANG_BITS); // unknown -> 0 (en)
  if (bonus) w.write(clamp(Math.round(r.bonusId!), 0, (1 << BONUS_ID_BITS) - 1), BONUS_ID_BITS);
  else w.write(clamp(Math.round(r.dayNumber ?? ID_EPOCH) - ID_EPOCH, 0, (1 << DAY_BITS) - 1), DAY_BITS);
  const capped = r.capped === true;
  w.write(capped ? 1 : 0, 1);

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

  // A CAPPED run ends here: the round never finished, so there is nothing to tick and the
  // section is absent from the format rather than written empty (#214).
  if (capped) return bytesToB64url(w.toBytes());

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

// Every version so far opens with the SAME header — `version | lang | day` — and only the
// payload after it differs. That is what lets an OLD link stay useful: a v1 token can't
// feed the v6 ruler, but its language and day are right there, so `/s/<v1token>` can send
// the reader to the day they were shown instead of a dead end.
//
// A NAMED LIST of retired SENTENCE versions, never a range (#214). A CURRENT-version token
// that `decodeResult` rejected is malformed, not legacy, and must keep 404-ing — otherwise
// a hand-crafted token would earn a redirect instead of the flat refusal the codec
// promises. And since the sentence version passed the retired Word mode's ids (3–5) at
// the v6 bump, a range would additionally hand one of those old Word links that same
// redirect.
interface LegacyShareTarget {
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
    if (!LEGACY_SENTENCE_VERSIONS.includes(version)) return null;
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
    const version = rd.read(VERSION_BITS);
    if (version !== SHARE_VERSION && version !== BONUS_SHARE_VERSION) return null;
    const lang = SHARE_LANGS[rd.read(LANG_BITS)];
    if (!lang) return null;
    const which: Pick<ShareResult, 'dayNumber' | 'bonusId'> =
      version === BONUS_SHARE_VERSION
        ? { bonusId: rd.read(BONUS_ID_BITS) }
        : { dayNumber: rd.read(DAY_BITS) + ID_EPOCH };
    if (which.bonusId !== undefined && (which.bonusId < BONUS_ID_MIN || which.bonusId > BONUS_ID_MAX)) {
      return null; // not a bonus id any publish could have minted
    }
    const capped = rd.read(1) === 1;
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

    const solvedAt: (number | null)[] = [];
    if (!capped) {
      const idxBits = bitLength(Math.max(1, score));
      const tickCount = rd.read(TICK_COUNT_BITS);
      for (let i = 0; i < tickCount; i += 1) {
        if (rd.read(1) === 0) {
          solvedAt.push(null);
          continue;
        }
        const at = rd.read(idxBits);
        if (at < 1 || at > score) return null; // a tick must land on a real try
        solvedAt.push(at);
      }
    }

    // Only the final byte's padding bits (0..7) may remain; a whole extra byte means the
    // token was tampered/extended.
    if (rd.remainingBits >= 8) return null;
    return { lang, ...which, score, trajectory, solvedAt, capped };
  } catch {
    return null; // bit overrun (truncated token)
  }
}
