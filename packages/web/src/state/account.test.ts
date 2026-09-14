// CONTRACT (#204/#271): the group departure is a DURABLE JOB. The deleted account's
// memberships cannot ride the adoption transaction (a re-read until empty is what makes
// the drop complete), so the adoption commits the job and the server drains what it can
// before answering — `departurePending` is it saying "not all of it". A membership left
// standing is a ghost on every one of those groups, so the client may not simply leave the
// rest for whenever the player next opens `/account`: a successful link RESUMES the same
// bounded, backed-off, epoch-fenced drain the summary read uses.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const postLinkBody = vi.hoisted(() => vi.fn());
const identity = vi.hoisted(() => ({
  current: {
    identity: { token: 'f'.repeat(64), accountId: 'lfd5pqz5pa7zjm5u', deviceId: 'd'.repeat(16) },
    epoch: `lfd5pqz5pa7zjm5u:${'d'.repeat(16)}`,
  } as { identity: { token: string; accountId: string; deviceId: string }; epoch: string } | null,
}));

vi.mock('../api', () => ({
  linkUrl: () => 'https://api.test/link',
  postLinkBody,
  parseAccountSummary: (data: unknown) => data as { departurePending: boolean },
}));
vi.mock('../identity', () => ({
  currentRequestIdentity: () => identity.current,
  deviceIdentity: () => identity.current?.identity ?? null,
  identityEpochOf: (value: { accountId: string; deviceId: string }) =>
    `${value.accountId}:${value.deviceId}`,
}));
vi.mock('./signedOutVerdict', () => ({ adoptSignedOutVerdict: vi.fn() }));

const { resumeDepartureDrain } = await import('./account');

const answered = (departurePending: boolean) => ({
  ok: true,
  json: async () => ({ departurePending }),
});

beforeEach(() => {
  vi.useFakeTimers();
  postLinkBody.mockReset();
  identity.current = {
    identity: { token: 'f'.repeat(64), accountId: 'lfd5pqz5pa7zjm5u', deviceId: 'd'.repeat(16) },
    epoch: `lfd5pqz5pa7zjm5u:${'d'.repeat(16)}`,
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('resumeDepartureDrain — a link that still owes a departure', () => {
  it('does NOTHING when the server finished the fan-out — departurePending false is done', async () => {
    resumeDepartureDrain(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(postLinkBody).not.toHaveBeenCalled();
  });

  it('asks again, with the device token, until the server says the job is drained', async () => {
    postLinkBody.mockResolvedValueOnce(answered(true)).mockResolvedValueOnce(answered(false));
    resumeDepartureDrain(true);

    // BACKED OFF, never immediate: the identity change has already committed and nobody is
    // waiting on this.
    expect(postLinkBody).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(postLinkBody).toHaveBeenCalledTimes(2);
    expect(postLinkBody).toHaveBeenCalledWith('https://api.test/link', {
      token: 'f'.repeat(64),
    });
  });

  it('is BOUNDED — a server that keeps reporting work stops being asked', async () => {
    postLinkBody.mockResolvedValue(answered(true));
    resumeDepartureDrain(true);
    await vi.advanceTimersByTimeAsync(600_000);
    // DRAIN_ATTEMPTS; the job is durable either way.
    expect(postLinkBody).toHaveBeenCalledTimes(4);
  });

  it('is FENCED: an identity this device has left never has its merge drained under it', async () => {
    postLinkBody.mockResolvedValue(answered(true));
    resumeDepartureDrain(true);
    identity.current = null;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(postLinkBody).not.toHaveBeenCalled();
  });

  it('does not resume at all when there is no identity to resume as', async () => {
    identity.current = null;
    resumeDepartureDrain(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(postLinkBody).not.toHaveBeenCalled();
  });
});
