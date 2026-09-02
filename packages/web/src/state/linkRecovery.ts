import type { AccountSummary, LinkResult } from '../api';

// Turn an authoritative `{token}` read into the result of an earlier VERIFY whose network
// outcome was ambiguous. The read proves completion only when the account now carries the
// exact requested address; otherwise the original failure still stands.
export function recoveredLinkResult(input: {
  summary: AccountSummary;
  previousAccountId: string;
  previousEmail: string | null;
  requestedEmail: string;
  bindingAuthorized: boolean;
}): LinkResult | null {
  const { summary, previousAccountId, previousEmail, requestedEmail, bindingAuthorized } = input;
  if (summary.email !== requestedEmail) return null;
  const outcome =
    summary.accountId !== previousAccountId
      ? 'adopted'
      : previousEmail === requestedEmail || !bindingAuthorized
        ? 'already_bound'
        : 'bound';
  return {
    outcome,
    accountId: summary.accountId,
    deviceId: summary.deviceId,
    email: requestedEmail,
    mergePending: summary.mergePending,
    stakes: null,
  };
}
