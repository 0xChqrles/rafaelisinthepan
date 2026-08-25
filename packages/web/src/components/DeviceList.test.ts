import { describe, expect, it } from 'vitest';
import type { DeviceListing, DeviceRow } from '../api';
import { revokedCallingDevice } from './DeviceList';

const CALLER = 'a'.repeat(16);
const OTHER = 'b'.repeat(16);

function row(deviceId: string, current: boolean): DeviceRow {
  return {
    revokeKey: current ? 'c'.repeat(64) : 'd'.repeat(64),
    deviceId,
    device: 'Mac',
    os: 'macOS',
    browser: 'Safari',
    createdAt: '2026-08-23T00:00:00.000Z',
    lastSeenAt: '2026-08-24T00:00:00.000Z',
    current,
  };
}

function listing(devices: DeviceRow[]): DeviceListing {
  return { accountId: 'p'.repeat(16), deviceId: CALLER, devices };
}

describe('DeviceList self-revocation (#216)', () => {
  it('signs this tab out only when the authoritative answer omits the calling row', () => {
    expect(revokedCallingDevice(listing([row(OTHER, false)]), CALLER)).toBe(true);
    expect(revokedCallingDevice(listing([row(CALLER, true), row(OTHER, false)]), CALLER)).toBe(
      false,
    );
  });

  it('never treats removal of another row as a sign-out of the caller', () => {
    expect(revokedCallingDevice(listing([row(CALLER, true)]), OTHER)).toBe(false);
  });
});
