// CONTRACT (#216): a device holds a REVOCABLE token and the server assigns the account id.
// The token's wire format is what the web mints and the backend keys its one device item
// by, so a looser or non-canonical spelling would fork one device into two rows — or let a
// revoked token key a different one. The ids keep the shape `assigned.ts` reads.

import { describe, expect, it } from 'vitest';
import {
  DEVICE_ID_PATTERN,
  PUBLIC_ID_PATTERN,
  generateDeviceId,
  generateDeviceToken,
  generatePublicId,
  isValidDeviceToken,
} from './identity';

describe('the device token (#216)', () => {
  it('generates 256 bits as 64 lowercase hex characters, freshly each time', () => {
    const first = generateDeviceToken();
    const second = generateDeviceToken();
    expect(isValidDeviceToken(first)).toBe(true);
    expect(isValidDeviceToken(second)).toBe(true);
    expect(first).not.toBe(second);
  });

  it('accepts exactly the canonical wire format and nothing looser', () => {
    const canonical = '0'.repeat(64);
    expect(isValidDeviceToken(canonical)).toBe(true);
    // Never normalized: an uppercase spelling hashes differently, so admitting it would
    // key a second row for one device.
    expect(isValidDeviceToken('A'.repeat(64))).toBe(false);
    expect(isValidDeviceToken('0'.repeat(63))).toBe(false);
    expect(isValidDeviceToken('0'.repeat(65))).toBe(false);
    expect(isValidDeviceToken(`g${'0'.repeat(63)}`)).toBe(false);
    // The retired #187 secret was 32 hex characters — it is not a device token.
    expect(isValidDeviceToken('00112233445566778899aabbccddeeff')).toBe(false);
    expect(isValidDeviceToken(42)).toBe(false);
    expect(isValidDeviceToken(null)).toBe(false);
  });
});

describe('server-assigned ids (#216)', () => {
  it('mints account ids in the shape every display surface already reads', () => {
    const id = generatePublicId();
    expect(id).toMatch(PUBLIC_ID_PATTERN);
    expect(generatePublicId()).not.toBe(id);
  });

  it('mints device ids in that same shape', () => {
    const id = generateDeviceId();
    expect(id).toMatch(DEVICE_ID_PATTERN);
    expect(generateDeviceId()).not.toBe(id);
  });
});
