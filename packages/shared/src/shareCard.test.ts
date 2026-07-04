// CONTRACT: the share-card codec (packages/shared/src/shareCard.ts). The bit-packed token
// must round-trip a result (squares within one quantization step), stay short + URL-safe,
// derive the square count from the score, and REJECT any malformed input.

import { describe, it, expect } from 'vitest';
import { encodeResult, decodeResult, squareCount, MAX_SQUARES, type ShareResult } from './shareCard';

// A mid-length game: squareCount(42) === 9, so the squares array has 9 entries.
const sample: ShareResult = { lang: 'fr', dayNumber: 20638, score: 42, squares: [8, 20, 35, 51, 67, 80, 93, 100, 100] };

// One quantization step (100/31 ≈ 3.23%); squares survive encode within half a step.
const QUANT_STEP = 100 / 31;

describe('encodeResult / decodeResult — round-trip', () => {
  it('preserves lang, dayNumber and score exactly', () => {
    const d = decodeResult(encodeResult(sample));
    expect(d?.lang).toBe('fr');
    expect(d?.dayNumber).toBe(20638);
    expect(d?.score).toBe(42);
  });

  it('derives the square count from the score (not stored)', () => {
    const d = decodeResult(encodeResult(sample));
    expect(d?.squares).toHaveLength(squareCount(42));
    expect(sample.squares).toHaveLength(squareCount(42)); // the input already matches
  });

  it('round-trips each square within one quantization step (colors are indistinguishable)', () => {
    const d = decodeResult(encodeResult(sample));
    d?.squares.forEach((v, i) => expect(Math.abs(v - sample.squares[i])).toBeLessThanOrEqual(QUANT_STEP));
  });

  it('keeps the squares monotonic (still reads cold -> hot)', () => {
    const d = decodeResult(encodeResult(sample));
    for (let i = 1; i < (d?.squares.length ?? 0); i += 1) {
      expect(d!.squares[i]).toBeGreaterThanOrEqual(d!.squares[i - 1]);
    }
  });

  it('handles the largest game (18 squares, big score)', () => {
    const big: ShareResult = { lang: 'en', dayNumber: 30000, score: 300, squares: Array(18).fill(60) };
    const d = decodeResult(encodeResult(big));
    expect(d?.score).toBe(300);
    expect(d?.squares).toHaveLength(MAX_SQUARES);
  });
});

describe('token shape — short + URL-safe', () => {
  it('is base64url only', () => {
    expect(encodeResult(sample)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('a perfect game packs to <= 8 chars; the 18-square max to <= 24', () => {
    const perfect = encodeResult({ lang: 'fr', dayNumber: 20638, score: 3, squares: [40, 70, 100] });
    expect(perfect.length).toBeLessThanOrEqual(8);
    const max = encodeResult({ lang: 'en', dayNumber: 30000, score: 300, squares: Array(18).fill(50) });
    expect(max.length).toBeLessThanOrEqual(24);
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

  it('rejects an unknown version (leading nibble != 1)', () => {
    // A v1 token's first 4 bits are 0001, so its first char is in E..H; force version 0.
    expect(decodeResult(`A${encodeResult(sample).slice(1)}`)).toBeNull();
  });
});
