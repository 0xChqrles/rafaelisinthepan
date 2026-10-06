import { describe, expect, it } from 'vitest';
import type { DeviceListing, DeviceRow } from '../api';
import { Refused, revokedCallingDevice, signOutOutcome } from './DeviceList';

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

// CONTRACT (root AGENTS.md, the live routes): a 5xx, a transport failure or an unreadable body is
// NEVER a verdict — on a write whose outcome is unknown the client READS before it says or
// writes anything. A sign-out's line says NOT SIGNED OUT only off a readable answer.
describe('a sign-out whose answer is lost (#216)', () => {
  const answer = (devices: DeviceRow[]) => ({ listing: listing(devices), epoch: 'e1' });
  const lost = () => Promise.reject(new Error('devices answered 500'));
  const neverRead = () => Promise.reject(new Error('the list was read'));

  it('takes the line away when the answer says it is gone', async () => {
    const out = await signOutOutcome(OTHER, () => Promise.resolve(answer([row(CALLER, true)])), neverRead);
    expect(out?.kind).toBe('gone');
  });

  it('says NOT SIGNED OUT when the answer still lists the line', async () => {
    const out = await signOutOutcome(
      OTHER,
      () => Promise.resolve(answer([row(CALLER, true), row(OTHER, false)])),
      neverRead,
    );
    expect(out?.kind).toBe('refused');
  });

  it('says NOT SIGNED OUT on a refusal the route read (a 4xx), without reading again', async () => {
    const out = await signOutOutcome(OTHER, () => Promise.reject(new Refused('devices refused 400')), neverRead);
    expect(out).toEqual({ kind: 'refused' });
  });

  it('reads the list on a lost answer, and the line leaves when the sign-out had landed', async () => {
    let reads = 0;
    const out = await signOutOutcome(OTHER, lost, () => {
      reads += 1;
      return Promise.resolve(answer([row(CALLER, true)]));
    });
    expect(reads).toBe(1);
    expect(out?.kind).toBe('gone');
  });

  it('reads the list on a lost answer, and says NOT SIGNED OUT only when the list still holds it', async () => {
    const out = await signOutOutcome(OTHER, lost, () =>
      Promise.resolve(answer([row(CALLER, true), row(OTHER, false)])),
    );
    expect(out?.kind).toBe('refused');
  });

  it('claims nothing when neither the sign-out nor the read answered', async () => {
    const offline = () => Promise.reject(new TypeError('Failed to fetch'));
    expect(await signOutOutcome(OTHER, offline, offline)).toEqual({ kind: 'unanswered' });
    // A refused READ says nothing about the sign-out either.
    expect(await signOutOutcome(OTHER, lost, () => Promise.reject(new Refused('devices refused 403')))).toEqual({
      kind: 'unanswered',
    });
  });

  it('leaves a lost sign-out of THIS device to the read\'s own verdict', async () => {
    // Its own line gone, the read is the server's `unknown_device` — adopted inside the call,
    // which then answers null: another surface (the signed-out screen) says it.
    expect(await signOutOutcome(CALLER, lost, () => Promise.resolve(null))).toBe(null);
  });

  it('signs this device out off a successful self-revocation', async () => {
    const out = await signOutOutcome(CALLER, () => Promise.resolve(answer([row(OTHER, false)])), neverRead);
    expect(out?.kind).toBe('self');
  });
});
