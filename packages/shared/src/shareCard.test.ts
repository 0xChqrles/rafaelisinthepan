// CONTRACT: the share-card codec (packages/shared/src/shareCard.ts). The token must
// round-trip a result, stay short + URL-safe, and REJECT any malformed input (so a
// hand-crafted token can never drive the renderer beyond its fixed template).

import { describe, it, expect } from 'vitest';
import { encodeResult, decodeResult, MAX_CARD_SQUARES, type ShareResult } from './shareCard';

const sample: ShareResult = { lang: 'fr', dayNumber: 123, score: 42, squares: [8, 20, 35, 51, 67, 80, 93, 100] };

describe('encodeResult / decodeResult', () => {
  it('round-trips a result (squares rounded to integer %)', () => {
    const decoded = decodeResult(encodeResult(sample));
    expect(decoded).toEqual(sample);
  });

  it('rounds fractional square percents on the way in', () => {
    const decoded = decodeResult(encodeResult({ ...sample, squares: [8.4, 20.6, 99.5] }));
    expect(decoded?.squares).toEqual([8, 21, 100]);
  });

  it('produces a short, URL-safe token (base64url alphabet only)', () => {
    const token = encodeResult({ ...sample, squares: Array(MAX_CARD_SQUARES).fill(50) });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeLessThan(40); // ~35 at the 18-square max
  });

  it('preserves the day number and score exactly', () => {
    const decoded = decodeResult(encodeResult({ ...sample, dayNumber: 4095, score: 300 }));
    expect(decoded?.dayNumber).toBe(4095);
    expect(decoded?.score).toBe(300);
  });

  it('caps the squares at MAX_CARD_SQUARES', () => {
    const decoded = decodeResult(encodeResult({ ...sample, score: 999, squares: Array(50).fill(70) }));
    expect(decoded?.squares).toHaveLength(MAX_CARD_SQUARES);
  });
});

describe('decodeResult — rejects malformed tokens (returns null)', () => {
  it('rejects non-base64url / garbage', () => {
    expect(decodeResult('not a token!!')).toBeNull();
    expect(decodeResult('')).toBeNull();
  });

  it('rejects a truncated token', () => {
    const token = encodeResult(sample);
    expect(decodeResult(token.slice(0, 4))).toBeNull();
  });

  it('rejects a length that disagrees with the declared square count', () => {
    // Tamper: append an extra base64url char so the byte length no longer matches n.
    const token = encodeResult(sample);
    expect(decodeResult(`${token}A`)).toBeNull();
  });

  it('rejects an unknown version byte', () => {
    // Re-encode with a bogus leading version by hand is awkward; instead assert a token
    // whose first byte is not the current version fails. Flip the first char to change byte 0.
    const token = encodeResult(sample);
    const tampered = (token[0] === 'B' ? 'C' : 'B') + token.slice(1);
    expect(decodeResult(tampered)).toBeNull();
  });
});
