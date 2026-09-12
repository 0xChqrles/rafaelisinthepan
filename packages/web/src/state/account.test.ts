// CONTRACT (#204): the friend merge is a DURABLE JOB. Up to 200 mutual edges is 800 rows,
// which cannot fit one DynamoDB transaction, so the adoption commits the job and the
// server drains what it can before answering — `mergePending` is it saying "not all of
// it". Those edges are consented relationships, so the client may not simply leave the
// rest for whenever the player next opens `/account`: a successful link RESUMES the same
// bounded, backed-off, epoch-fenced drain the summary read uses.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const postLinkBody = vi.hoisted(() => vi.fn());
const adoptLinkedAccount = vi.hoisted(() => vi.fn(() => true));
const identity = vi.hoisted(() => ({
  current: {
    identity: { token: 'f'.repeat(64), accountId: 'lfd5pqz5pa7zjm5u', deviceId: 'd'.repeat(16) },
    epoch: `lfd5pqz5pa7zjm5u:${'d'.repeat(16)}`,
  } as { identity: { token: string; accountId: string; deviceId: string }; epoch: string } | null,
}));

vi.mock('../api', () => ({
  linkUrl: () => 'https://api.test/link',
  postLinkBody,
  parseAccountSummary: (data: unknown) => data as { mergePending: boolean },
}));
vi.mock('../identity', () => ({
  adoptLinkedAccount,
  currentRequestIdentity: () => identity.current,
  deviceIdentity: () => identity.current?.identity ?? null,
  identityEpochOf: (value: { accountId: string; deviceId: string }) =>
    `${value.accountId}:${value.deviceId}`,
}));
vi.mock('./signedOutVerdict', () => ({ adoptSignedOutVerdict: vi.fn() }));

const { loadAccountSummary, resetAccountSummary, resumeMergeDrain, useAccountStore } =
  await import('./account');

const answered = (mergePending: boolean) => ({
  ok: true,
  json: async () => ({ mergePending }),
});

beforeEach(() => {
  vi.useFakeTimers();
  postLinkBody.mockReset();
  adoptLinkedAccount.mockClear();
  resetAccountSummary();
  identity.current = {
    identity: { token: 'f'.repeat(64), accountId: 'lfd5pqz5pa7zjm5u', deviceId: 'd'.repeat(16) },
    epoch: `lfd5pqz5pa7zjm5u:${'d'.repeat(16)}`,
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('resumeMergeDrain — a link that still owes a merge', () => {
  it('does NOTHING when the server finished the fan-out — mergePending false is done', async () => {
    resumeMergeDrain(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(postLinkBody).not.toHaveBeenCalled();
  });

  it('asks again, with the device token, until the server says the job is drained', async () => {
    postLinkBody.mockResolvedValueOnce(answered(true)).mockResolvedValueOnce(answered(false));
    resumeMergeDrain(true);

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
    resumeMergeDrain(true);
    await vi.advanceTimersByTimeAsync(600_000);
    // MERGE_DRAIN_ATTEMPTS; the job is durable either way.
    expect(postLinkBody).toHaveBeenCalledTimes(4);
  });

  it('is FENCED: an identity this device has left never has its merge drained under it', async () => {
    postLinkBody.mockResolvedValue(answered(true));
    resumeMergeDrain(true);
    identity.current = null;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(postLinkBody).not.toHaveBeenCalled();
  });

  it('does not resume at all when there is no identity to resume as', async () => {
    identity.current = null;
    resumeMergeDrain(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(postLinkBody).not.toHaveBeenCalled();
  });
});

// 2026-09-12: the ids a device holds are learned at the bootstrap and at an email link and
// never re-read — so a device moved to another account on the server (a lost-token repair)
// kept asking public reads about an account that no longer existed. The summary is the
// server's own word on which account this device acts as, and it wins.
describe('the account summary re-homes a device the server has moved', () => {
  const summaryOf = (accountId: string, deviceId: string) => ({
    ok: true,
    json: async () => ({ accountId, deviceId, email: null, createdAt: '', mergePending: false }),
  });

  it('adopts the account and device the server names when they differ from the held ones', async () => {
    postLinkBody.mockResolvedValueOnce(summaryOf('vf4dwlhgx4i7hh3m', 'e'.repeat(16)));
    loadAccountSummary();
    await vi.waitFor(() => expect(adoptLinkedAccount).toHaveBeenCalled());
    expect(adoptLinkedAccount).toHaveBeenCalledWith(identity.current!.epoch, {
      accountId: 'vf4dwlhgx4i7hh3m',
      deviceId: 'e'.repeat(16),
    });
    // The adoption's scope reset re-reads; this answer is not published as the held one's.
    expect(useAccountStore.getState().summary).toBeNull();
  });

  it('adopts nothing when the server names the account the device already holds', async () => {
    postLinkBody.mockResolvedValueOnce(summaryOf('lfd5pqz5pa7zjm5u', 'd'.repeat(16)));
    loadAccountSummary();
    await vi.waitFor(() => expect(useAccountStore.getState().phase).toBe('ready'));
    expect(adoptLinkedAccount).not.toHaveBeenCalled();
    expect(useAccountStore.getState().summary?.accountId).toBe('lfd5pqz5pa7zjm5u');
  });
});
