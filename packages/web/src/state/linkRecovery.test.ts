import { describe, expect, it } from 'vitest';
import { recoveredLinkResult } from './linkRecovery';

const SOURCE = 'abcdefghijklmnop';
const TARGET = 'qrstuvwxyz234567';
const DEVICE = 'nq2yv6cme4jkbhtx';
const EMAIL = 'zoe@example.com';

function summary(accountId: string, email: string | null) {
  return {
    accountId,
    deviceId: DEVICE,
    email,
    createdAt: '2026-08-12T10:00:00.000Z',
    mergePending: false,
  };
}

describe('ambiguous email-link recovery', () => {
  it('recognizes a committed adoption from the token now resolving to the target', () => {
    expect(
      recoveredLinkResult({
        summary: summary(TARGET, EMAIL),
        previousAccountId: SOURCE,
        previousEmail: null,
        requestedEmail: EMAIL,
        bindingAuthorized: true,
      }),
    ).toMatchObject({ outcome: 'adopted', accountId: TARGET, email: EMAIL });
  });

  it('recognizes a committed bind without inventing success for another address', () => {
    expect(
      recoveredLinkResult({
        summary: summary(SOURCE, EMAIL),
        previousAccountId: SOURCE,
        previousEmail: null,
        requestedEmail: EMAIL,
        bindingAuthorized: true,
      }),
    ).toMatchObject({ outcome: 'bound', accountId: SOURCE });
    expect(
      recoveredLinkResult({
        summary: summary(SOURCE, 'other@example.com'),
        previousAccountId: SOURCE,
        previousEmail: null,
        requestedEmail: EMAIL,
        bindingAuthorized: true,
      }),
    ).toBeNull();
  });

  it('treats the same account and address as already bound when recovery did not authorize a bind', () => {
    expect(
      recoveredLinkResult({
        summary: summary(SOURCE, EMAIL),
        previousAccountId: SOURCE,
        previousEmail: null,
        requestedEmail: EMAIL,
        bindingAuthorized: false,
      }),
    ).toMatchObject({ outcome: 'already_bound', accountId: SOURCE });
  });
});
