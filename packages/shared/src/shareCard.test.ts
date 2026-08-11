// CONTRACT: the share-card codec (packages/shared/src/shareCard.ts). The bit-packed token
// must round-trip a result — the RAW per-try run and its solve ticks since v2, so the card
// can draw the same ruler the solved screen does (each cell within one quantization step) —
// stay short + URL-safe, derive the run's length from the score, and REJECT any malformed
// input (a v1 bucketed-squares token included) — while still recovering enough of a
// SUPERSEDED token's header to point its reader at the day it named.

import { describe, it, expect } from 'vitest';
import {
  encodeResult,
  decodeResult,
  decodeLegacyShareTarget,
  encodeWordResult,
  decodeWordResult,
  wordShareScore,
  WORD_RARITY_GRADES,
  type ShareResult,
} from './shareCard';

// A mid-length game: 12 tries, most of which don't move the reconstruction, and three
// secrets dropped on tries 4, 9 and 12 (the last guess always solves the sentence).
const sample: ShareResult = {
  lang: 'fr',
  dayNumber: 20638,
  score: 12,
  trajectory: [0, 0, 18, 41, 41, 41, 55, 55, 72, 72, 72, 100],
  solvedAt: [4, 12, 9],
};

// One quantization step (100/31 ≈ 3.23%); cells survive encode within half a step.
const QUANT_STEP = 100 / 31;

describe('encodeResult / decodeResult — round-trip', () => {
  it('preserves lang, dayNumber and score exactly', () => {
    const d = decodeResult(encodeResult(sample));
    expect(d?.lang).toBe('fr');
    expect(d?.dayNumber).toBe(20638);
    expect(d?.score).toBe(12);
  });

  it('derives the run length from the score (one cell per counted try, not stored)', () => {
    const d = decodeResult(encodeResult(sample));
    expect(d?.trajectory).toHaveLength(sample.score);
    expect(sample.trajectory).toHaveLength(sample.score); // the input already matches
  });

  it('round-trips each try within one quantization step (colors are indistinguishable)', () => {
    const d = decodeResult(encodeResult(sample));
    d?.trajectory.forEach((v, i) =>
      expect(Math.abs(v - sample.trajectory[i])).toBeLessThanOrEqual(QUANT_STEP),
    );
  });

  it('keeps the run monotonic (a try can never undo reconstruction)', () => {
    const d = decodeResult(encodeResult(sample));
    for (let i = 1; i < (d?.trajectory.length ?? 0); i += 1) {
      expect(d!.trajectory[i]).toBeGreaterThanOrEqual(d!.trajectory[i - 1]);
    }
  });

  it('round-trips the solve ticks EXACTLY, in sentence order (they are the ruler marks)', () => {
    const d = decodeResult(encodeResult(sample));
    expect(d?.solvedAt).toEqual([4, 12, 9]);
  });

  it('keeps several secrets dropped by ONE guess on the same try (one shared tick)', () => {
    const one: ShareResult = { ...sample, solvedAt: [12, 12, 12] };
    expect(decodeResult(encodeResult(one))?.solvedAt).toEqual([12, 12, 12]);
  });

  it('round-trips an unsolved secret as null (an unfinished run)', () => {
    const dnf: ShareResult = { ...sample, solvedAt: [4, null, 9] };
    expect(decodeResult(encodeResult(dnf))?.solvedAt).toEqual([4, null, 9]);
  });

  it('handles a perfect game (3 tries, a tick on each)', () => {
    const perfect: ShareResult = {
      lang: 'en',
      dayNumber: 20638,
      score: 3,
      trajectory: [33, 67, 100],
      solvedAt: [1, 2, 3],
    };
    const d = decodeResult(encodeResult(perfect));
    expect(d?.score).toBe(3);
    expect(d?.trajectory).toHaveLength(3);
    expect(d?.solvedAt).toEqual([1, 2, 3]);
  });

  it('handles a long game (300 tries) — every cell survives', () => {
    const trajectory = Array.from({ length: 300 }, (_, i) => (100 * (i + 1)) / 300);
    const big: ShareResult = { lang: 'en', dayNumber: 30000, score: 300, trajectory, solvedAt: [120, 240, 300] };
    const d = decodeResult(encodeResult(big));
    expect(d?.score).toBe(300);
    expect(d?.trajectory).toHaveLength(300);
    expect(d?.solvedAt).toEqual([120, 240, 300]);
  });

  it('round-trips a scoreless result — anything it writes, it can read back', () => {
    // No tries means no try for a tick to point at, and the decoder rejects a tick outside
    // 1..score. The encoder must therefore not emit one — a token this codec produces can
    // never be a token it refuses.
    const none: ShareResult = {
      lang: 'en',
      dayNumber: 20638,
      score: 0,
      trajectory: [],
      solvedAt: [null, null, null],
    };
    const d = decodeResult(encodeResult(none));
    expect(d?.score).toBe(0);
    expect(d?.trajectory).toEqual([]);
    expect(d?.solvedAt).toEqual([null, null, null]);
  });
});

describe('token shape — short + URL-safe', () => {
  it('is base64url only', () => {
    expect(encodeResult(sample)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('a perfect game packs to <= 12 chars; a 12-try game to <= 24', () => {
    const perfect = encodeResult({
      lang: 'fr',
      dayNumber: 20638,
      score: 3,
      trajectory: [33, 67, 100],
      solvedAt: [1, 2, 3],
    });
    expect(perfect.length).toBeLessThanOrEqual(12);
    expect(encodeResult(sample).length).toBeLessThanOrEqual(24);
  });

  it('a try that does not improve costs ONE bit — a long stall barely grows the link', () => {
    // 100 dead guesses before the same 3 improvements: 100 bits, not 100 × 5. This is what
    // keeps a long game shareable — a long game is long because most of it doesn't improve.
    const stalled: ShareResult = {
      lang: 'en',
      dayNumber: 20638,
      score: 103,
      trajectory: [...Array(100).fill(0), 40, 70, 100],
      solvedAt: [101, 102, 103],
    };
    expect(encodeResult(stalled).length).toBeLessThanOrEqual(36); // ~96 chars if flat-packed
    expect(decodeResult(encodeResult(stalled))?.trajectory).toHaveLength(103);
  });
});

describe('decodeResult — rejects malformed tokens (returns null)', () => {
  it('rejects non-base64url / garbage', () => {
    expect(decodeResult('not a token!!')).toBeNull();
    expect(decodeResult('')).toBeNull();
  });

  it('rejects a truncated token (bit overrun)', () => {
    expect(decodeResult(encodeResult(sample).slice(0, 3))).toBeNull();
  });

  it('rejects a whole extra byte of trailing data', () => {
    expect(decodeResult(`${encodeResult(sample)}AAAA`)).toBeNull();
  });

  it('rejects an unknown version (leading nibble != 2)', () => {
    // A v2 token's first 4 bits are 0010, so its first char is in I..L; force version 0.
    expect(decodeResult(`A${encodeResult(sample).slice(1)}`)).toBeNull();
  });

  it('rejects a v1 token — bucketed squares cannot feed a per-try ruler', () => {
    // A hand-built v1 payload: version 1 | lang 0 | day 0 | scoreLen 0 | 3 squares × 5b.
    // (Its leading nibble is 0001, which the version check refuses.)
    expect(decodeResult('EAAAAAAA')).toBeNull();
  });
});

// A superseded token can't draw the card, but every version shares the opening header, so
// its lang + day survive — enough for the backend to send an old link's reader to the day
// it named instead of a dead end.
describe('decodeLegacyShareTarget — where an OLD link should still land', () => {
  // v1 header: version 1 | lang 1 (fr) | day 638 | scoreLen 0 …, then whatever payload.
  const v1 = (() => {
    const bits = [
      ...[0, 0, 0, 1], // version 1
      ...[0, 1], // lang index 1 -> fr
      ...(638).toString(2).padStart(15, '0').split('').map(Number), // day - ID_EPOCH
      ...[0, 0, 0, 0], // scoreLen 0 -> score 0
      ...Array(15).fill(0), // v1 square payload — never read here
    ];
    const bytes = new Uint8Array(Math.ceil(bits.length / 8));
    bits.forEach((b, i) => {
      if (b) bytes[i >> 3] |= 1 << (7 - (i & 7));
    });
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const rem = bytes.length - i;
      const [b0, b1, b2] = [bytes[i], rem > 1 ? bytes[i + 1] : 0, rem > 2 ? bytes[i + 2] : 0];
      out += B64[b0 >> 2] + B64[((b0 & 0x03) << 4) | (b1 >> 4)];
      if (rem > 1) out += B64[((b1 & 0x0f) << 2) | (b2 >> 6)];
      if (rem > 2) out += B64[b2 & 0x3f];
    }
    return out;
  })();

  it('recovers the lang and day of a superseded (v1) token', () => {
    expect(decodeResult(v1)).toBeNull(); // the ruler payload is genuinely unreadable
    expect(decodeLegacyShareTarget(v1)).toEqual({ version: 1, lang: 'fr', dayNumber: 20638 });
  });

  it('refuses a CURRENT-version token, so a forged one still gets a flat refusal', () => {
    // Truncating a real v2 token breaks decodeResult; it must NOT then look "legacy".
    const truncated = encodeResult(sample).slice(0, 3);
    expect(decodeResult(truncated)).toBeNull();
    expect(decodeLegacyShareTarget(truncated)).toBeNull();
    expect(decodeLegacyShareTarget(encodeResult(sample))).toBeNull();
  });

  it('refuses garbage and an unknown future version', () => {
    expect(decodeLegacyShareTarget('!!!!')).toBeNull();
    expect(decodeLegacyShareTarget('')).toBeNull();
    // Leading nibble 0 is not a version we ever shipped.
    expect(decodeLegacyShareTarget(`A${encodeResult(sample).slice(1)}`)).toBeNull();
  });
});

// Word mode's token (#156): its own format in the same version namespace — the common
// `version | lang | day` opening, the claims PER RARITY GRADE (v5 — commonest first; the
// claim count is DERIVED as their sum, never stored), then the accented display word
// needed by the self-contained OG card.
describe('encodeWordResult / decodeWordResult', () => {
  const word = { lang: 'fr', dayNumber: 20638, counts: [7, 3, 1, 1, 0], word: 'forêt' };

  it('round-trips lang, dayNumber, the per-rarity counts and the accented display word', () => {
    expect(decodeWordResult(encodeWordResult(word))).toEqual(word);
    const none = { ...word, lang: 'en', counts: [0, 0, 0, 0, 0], word: 'heart' };
    expect(decodeWordResult(encodeWordResult(none))).toEqual(none);
  });

  it("derives the claim count as the counts' sum — the two can never disagree", () => {
    expect(wordShareScore(word.counts)).toBe(12);
    expect(wordShareScore([0, 0, 0, 0, 0])).toBe(0);
    const d = decodeWordResult(encodeWordResult(word));
    expect(wordShareScore(d!.counts)).toBe(12);
  });

  it('refuses a breakdown that is not exactly one count per grade', () => {
    expect(WORD_RARITY_GRADES).toBe(5);
    expect(() => encodeWordResult({ ...word, counts: [12] })).toThrow(RangeError);
    expect(() => encodeWordResult({ ...word, counts: [...word.counts, 0] })).toThrow(RangeError);
  });

  it('stays compact + URL-safe with the breakdown and display word included', () => {
    const token = encodeWordResult(word);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeLessThanOrEqual(24);
  });

  it('rejects a missing or impossibly long display word instead of truncating it', () => {
    expect(() => encodeWordResult({ ...word, word: '' })).toThrow(RangeError);
    expect(() => encodeWordResult({ ...word, word: 'é'.repeat(128) })).toThrow(RangeError);
    expect(() => encodeWordResult({ ...word, word: 'forêt\u0000' })).toThrow(RangeError);
  });

  it('the two formats never decode each other', () => {
    expect(decodeResult(encodeWordResult(word))).toBeNull();
    expect(decodeWordResult(encodeResult(sample))).toBeNull();
    // Nor does a word token look "legacy": a malformed or cross-format token still
    // gets the flat refusal, never a redirect.
    expect(decodeLegacyShareTarget(encodeWordResult(word))).toBeNull();
  });

  it('rejects malformed input (garbage, truncation, trailing data)', () => {
    expect(decodeWordResult('not a token!!')).toBeNull();
    expect(decodeWordResult('')).toBeNull();
    expect(decodeWordResult(encodeWordResult(word).slice(0, 2))).toBeNull();
    expect(decodeWordResult(`${encodeWordResult(word)}AAAA`)).toBeNull();
  });
});
