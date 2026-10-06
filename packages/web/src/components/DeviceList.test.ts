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
// NEVER a verdict — on a write whose outcome is unknown the client asks again before it says or
// writes anything. A sign-out is asked again by SENDING IT AGAIN (idempotent: a device already
// gone is the route's success, its answer corrected for it), never by a plain read of the list,
// which comes off an eventually consistent index and can still hold a device just signed out.
// A sign-out's line says NOT SIGNED OUT only off a readable answer to a sign-out.
describe('a sign-out whose answer is lost (#216)', () => {
  const answer = (devices: DeviceRow[]) => ({ listing: listing(devices), epoch: 'e1' });
  const lost = new Error('devices answered 500');
  // A sign-out answering each sending in turn, and counting them.
  function sendings(...answers: Array<ReturnType<typeof answer> | null | Error>) {
    let sent = 0;
    const revoke = () => {
      const next = answers[sent];
      sent += 1;
      if (next === undefined) return Promise.reject(new Error('sent once too often'));
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    };
    return { revoke, sent: () => sent };
  }

  it('takes the line away when the answer says it is gone', async () => {
    const s = sendings(answer([row(CALLER, true)]));
    expect((await signOutOutcome(OTHER, s.revoke))?.kind).toBe('gone');
    expect(s.sent()).toBe(1);
  });

  it('says NOT SIGNED OUT when the answer still lists the line', async () => {
    const s = sendings(answer([row(CALLER, true), row(OTHER, false)]));
    expect((await signOutOutcome(OTHER, s.revoke))?.kind).toBe('refused');
  });

  it('says NOT SIGNED OUT on a refusal the route read (a 4xx), without sending again', async () => {
    const s = sendings(new Refused('devices refused 400'));
    expect(await signOutOutcome(OTHER, s.revoke)).toEqual({ kind: 'refused' });
    expect(s.sent()).toBe(1);
  });

  it('sends the sign-out again on a lost answer, and the line leaves when that answer says it is gone', async () => {
    // The first one landed and its answer was lost: the second finds the device absent, which
    // the route counts as done and filters out of the list it answers.
    const s = sendings(lost, answer([row(CALLER, true)]));
    expect((await signOutOutcome(OTHER, s.revoke))?.kind).toBe('gone');
    expect(s.sent()).toBe(2);
  });

  it("says NOT SIGNED OUT after a lost answer only off the second sending's own answer", async () => {
    const listed = sendings(lost, answer([row(CALLER, true), row(OTHER, false)]));
    expect((await signOutOutcome(OTHER, listed.revoke))?.kind).toBe('refused');
    const refused = sendings(new TypeError('Failed to fetch'), new Refused('devices refused 400'));
    expect(await signOutOutcome(OTHER, refused.revoke)).toEqual({ kind: 'refused' });
  });

  it('claims nothing when neither sending answered, and sends no third', async () => {
    const offline = new TypeError('Failed to fetch');
    const s = sendings(offline, offline);
    expect(await signOutOutcome(OTHER, s.revoke)).toEqual({ kind: 'unanswered' });
    expect(s.sent()).toBe(2);
    expect(await signOutOutcome(OTHER, sendings(lost, lost).revoke)).toEqual({ kind: 'unanswered' });
  });

  it("leaves a lost sign-out of THIS device to the second sending's own verdict", async () => {
    // The first one landed: the device is gone, so the second is the server's `unknown_device`
    // — adopted inside the call, which then answers null: the signed-out screen says it.
    expect(await signOutOutcome(CALLER, sendings(lost, null).revoke)).toBe(null);
  });

  it('signs this device out off a successful self-revocation', async () => {
    const out = await signOutOutcome(CALLER, sendings(answer([row(OTHER, false)])).revoke);
    expect(out?.kind).toBe('self');
  });

  it('signs this device out when the second sending is the one that answers', async () => {
    const out = await signOutOutcome(CALLER, sendings(lost, answer([row(OTHER, false)])).revoke);
    expect(out?.kind).toBe('self');
  });
});
