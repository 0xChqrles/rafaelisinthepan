// CONTRACT (#187): the secret key IS the account. The web generates and stores it, the
// backend derives the publicId every score row is keyed by — so the format and the
// derivation are asserted against the spec, including a pinned vector: a silent change
// here would silently fork every player into a new identity.

import { describe, expect, it } from 'vitest';
import {
  PUBLIC_ID_PATTERN,
  generateSecret,
  isValidSecret,
  publicIdFromSecret,
} from './identity';

describe('the player secret (#187)', () => {
  it('generates 128 bits as 32 lowercase hex characters, freshly each time', () => {
    const first = generateSecret();
    const second = generateSecret();
    expect(isValidSecret(first)).toBe(true);
    expect(isValidSecret(second)).toBe(true);
    expect(first).not.toBe(second);
  });

  it('accepts exactly the wire format and nothing looser', () => {
    expect(isValidSecret('00112233445566778899aabbccddeeff')).toBe(true);
    expect(isValidSecret('00112233445566778899AABBCCDDEEFF')).toBe(false); // uppercase
    expect(isValidSecret('00112233445566778899aabbccddeef')).toBe(false); // 31 chars
    expect(isValidSecret('00112233445566778899aabbccddeeff0')).toBe(false); // 33 chars
    expect(isValidSecret('g0112233445566778899aabbccddeeff')).toBe(false); // non-hex
    expect(isValidSecret(42)).toBe(false);
    expect(isValidSecret(null)).toBe(false);
  });
});

describe('publicId derivation (#187)', () => {
  it('is the pinned truncated-SHA-256 base32 form — 80 bits in 16 characters', async () => {
    // Pinned vector: sha256("00112233445566778899aabbccddeeff") starts 5947d7c33d78…;
    // its first 10 bytes base32-encode to exactly this. Moving it forks identities.
    await expect(publicIdFromSecret('00112233445566778899aabbccddeeff')).resolves.toBe(
      'lfd5pqz5pa7zjm5u',
    );
  });

  it('is deterministic per secret and distinct across secrets', async () => {
    const a = generateSecret();
    const b = generateSecret();
    const idA = await publicIdFromSecret(a);
    expect(idA).toMatch(PUBLIC_ID_PATTERN);
    await expect(publicIdFromSecret(a)).resolves.toBe(idA);
    await expect(publicIdFromSecret(b)).resolves.not.toBe(idA);
  });

  it('refuses to derive anything from a malformed secret', async () => {
    await expect(publicIdFromSecret('not-a-secret')).rejects.toThrow(/malformed/);
  });
});
