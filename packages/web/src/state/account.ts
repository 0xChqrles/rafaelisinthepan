// What this device's ACCOUNT is, as the account screen needs it (#204's UX rework).
//
// It exists because the account SCREEN and the email FLOW are two screens now, and both
// need the same one fact — is this account saved, and to what address. Holding it here
// rather than inside either screen is what lets `/account` state the answer without
// mounting the flow, and what keeps a link that lands on `/account/email` from leaving a
// stale address behind it on the screen the player returns to.
//
// It is also where the friend-merge DRAIN lives, for the same reason: the `{token}` read
// and the drain are ONE message on the server, so whoever reads also finishes whatever an
// interrupted link left queued. Retried, bounded and backed off — those edges are consented
// relationships, so the job may not simply be abandoned, and it is durable either way.
//
// TRANSIENT, never persisted: it is the server's answer about the caller, and #211's rule
// applies — a summary that has not arrived is UNKNOWN, never a guessed empty one.

import { create } from 'zustand';
import { linkUrl, parseAccountSummary, postLinkBody, type AccountSummary } from '../api';
import { currentRequestIdentity, deviceIdentity, identityEpochOf } from '../identity';
import { adoptSignedOutVerdict } from './signedOutVerdict';

// How hard the client chases a merge the server has not finished. The identity change has
// already committed, so this is housekeeping nobody is waiting on.
const MERGE_DRAIN_ATTEMPTS = 4;
const MERGE_DRAIN_DELAY_MS = 1_500;

export type AccountPhase = 'idle' | 'loading' | 'ready' | 'failed';

interface AccountState {
  phase: AccountPhase;
  // The account this device holds, or null when it holds none. `phase: 'ready'` with a null
  // summary is the TOKENLESS answer — a device with no account KNOWS its server state is
  // empty and must not call a private route to learn it (#216).
  summary: AccountSummary | null;
}

export const useAccountStore = create<AccountState>(() => ({ phase: 'idle', summary: null }));

// ONE flight per account, the `activeScoreFlights` pattern: the account screen and the email
// flow can mount in the same tick, and React's development effect replay fires every effect
// twice.
let flight: Promise<void> | null = null;
let loadedFor: string | null = null;

async function drain(token: string, epoch: string, pending: boolean): Promise<void> {
  let outstanding = pending;
  for (let attempt = 0; outstanding && attempt < MERGE_DRAIN_ATTEMPTS; attempt += 1) {
    await new Promise((done) => setTimeout(done, MERGE_DRAIN_DELAY_MS * 2 ** attempt));
    // The identity may have moved on between attempts — a sign-out, another tab's account.
    if (currentRequestIdentity(epoch) === null) return;
    try {
      const response = await postLinkBody(linkUrl(), { token });
      if (!response.ok) return;
      outstanding = parseAccountSummary(await response.json()).mergePending;
    } catch {
      return;
    }
  }
}

// Read what this account is. Called by the screens that show it; safe to call repeatedly.
export function loadAccountSummary(force = false): void {
  const identity = deviceIdentity();
  if (identity === null) {
    // An ANSWER, not a loading state: no token means no account, and no request.
    loadedFor = null;
    useAccountStore.setState({ phase: 'ready', summary: null });
    return;
  }
  if (!force && loadedFor === identity.accountId) return;
  if (flight) return;
  const epoch = identityEpochOf(identity);
  useAccountStore.setState((state) => ({
    phase: 'loading',
    // Keep a summary already in hand while a refresh is out — the leaderboard's
    // stale-but-good rule. A blank screen behind a re-read reads as a failure.
    summary: state.summary?.accountId === identity.accountId ? state.summary : null,
  }));
  flight = (async () => {
    try {
      const resolved = currentRequestIdentity(epoch);
      if (!resolved) return;
      const response = await postLinkBody(linkUrl(), { token: resolved.identity.token });
      if (!response.ok) {
        await adoptSignedOutVerdict(response, resolved.epoch);
        useAccountStore.setState({ phase: 'failed' });
        return;
      }
      const summary = parseAccountSummary(await response.json());
      // Fenced: an answer that outlived its identity describes an account this device no
      // longer acts as.
      if (currentRequestIdentity(epoch) === null) return;
      loadedFor = summary.accountId;
      useAccountStore.setState({ phase: 'ready', summary });
      if (summary.mergePending) void drain(resolved.identity.token, epoch, true);
    } catch {
      useAccountStore.setState({ phase: 'failed' });
    } finally {
      flight = null;
    }
  })();
}

// A LINK LANDED, AND IT MAY OWE A FRIEND MERGE (#204). Up to 200 mutual edges is 800 rows,
// which cannot fit one transaction, so the adoption commits a durable JOB and the server
// drains what it can before answering — `mergePending` is it saying "not all of it". The
// edges are consented relationships, so the job may not simply be left for whenever the
// player next opens `/account`: this resumes the SAME bounded, backed-off, epoch-fenced
// drain the summary read uses, in the identity the link just landed on.
//
// Called AFTER the adoption has published, so the epoch it captures is the one the drain
// has to run under — an adopt CHANGES the account id, and a drain fenced on the epoch the
// verify started under would return on its first check without ever calling.
export function resumeMergeDrain(pending: boolean): void {
  if (!pending) return;
  const resolved = currentRequestIdentity();
  if (!resolved) return;
  void drain(resolved.identity.token, resolved.epoch, true);
}

// A link just landed. The flow already knows the answer, so the screen the player returns to
// must not have to re-read for it.
export function noteAccountEmail(accountId: string, email: string): void {
  useAccountStore.setState((state) => ({
    phase: 'ready',
    summary:
      state.summary?.accountId === accountId
        ? { ...state.summary, email }
        : // An ADOPT lands on an account this store has never read. Publish what is KNOWN
          // and let the next mount fill in the rest, rather than showing nothing.
          { accountId, deviceId: '', email, createdAt: '', mergePending: false },
  }));
  // An ADOPT lands on an account this store has never read, so the next `loadAccountSummary`
  // has to actually go — the address is known but the rest of the row is not.
  loadedFor = null;
}

export function useAccountSummary(): AccountState {
  return useAccountStore((state) => state);
}

// Registered in `identityScope`: the summary belongs to the ACCOUNT, and a device that
// leaves one may not keep showing its address.
export function resetAccountSummary(): void {
  flight = null;
  loadedFor = null;
  useAccountStore.setState({ phase: 'idle', summary: null });
}
