// CONTRACT: the share-card codec (packages/shared/src/shareCard.ts). The bit-packed token
// must round-trip a result — the RAW per-try run and its solve ticks since v2, so the card
// can draw the same ruler the solved screen does (each cell within one quantization step) —
// stay short + URL-safe, derive the run's length from the score, and REJECT any malformed
// input (a v1 bucketed-squares token included).

import { describe, it, expect } from 'vitest';
import { encodeResult, decodeResult, type ShareResult } from './shareCard';

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
