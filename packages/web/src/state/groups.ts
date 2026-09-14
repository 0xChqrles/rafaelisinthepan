// The player's GROUPS (#271), as every surface that draws them needs them: the leaderboard's
// tabs, the global board's member marks, the invite landing's "already a member" and the
// solved screen's standing line all read ONE answer to "which groups am I in".
//
// TRANSIENT, never persisted: it is the server's answer about the caller, and #211's rule
// applies — a list that has not arrived is UNKNOWN, never a guessed empty one. The one
// exception is the tokenless device, whose emptiness is a FACT (#216's no-private-fetch
// rule): it publishes ready-and-empty without a request.
//
// ACCOUNT-owned, so `identityScope` resets it; every write on `/groups` answers the list as
// it now stands, and `adoptGroups` is how a screen publishes that answer without a re-read.

import { create } from 'zustand';
import type { GroupSummary } from '@whippin/shared';
import { groupsUrl, parseGroups, postGroupsBody, type GroupsAnswer } from '../api';
import { currentRequestIdentity, deviceIdentity, identityEpochOf } from '../identity';
import { adoptSignedOutVerdict } from './signedOutVerdict';

export type GroupsPhase = 'idle' | 'loading' | 'ready' | 'failed';

interface GroupsState {
  phase: GroupsPhase;
  // The groups this device's account is in, or null while unknown. `phase: 'ready'` with
  // an empty list is an ANSWER — no groups — for a tokenless device and a deployed one alike.
  groups: GroupSummary[] | null;
}

export const useGroupsStore = create<GroupsState>(() => ({ phase: 'idle', groups: null }));

// ONE flight per account, the `activeScoreFlights` pattern.
let flight: Promise<void> | null = null;
let loadedFor: string | null = null;
let generation = 0;

// Refresh on each surface entry, keeping a previous answer visible while it loads.
export function loadGroups(): void {
  const identity = deviceIdentity();
  if (identity === null) {
    loadedFor = null;
    useGroupsStore.setState({ phase: 'ready', groups: [] });
    return;
  }
  if (flight) return;
  const epoch = identityEpochOf(identity);
  const requestGeneration = generation;
  const current = () => generation === requestGeneration && currentRequestIdentity(epoch) !== null;
  useGroupsStore.setState((state) => ({
    phase: 'loading',
    // Keep a list already in hand while a refresh is out — the leaderboard's
    // stale-but-good rule.
    groups: loadedFor === identity.accountId ? state.groups : null,
  }));
  flight = (async () => {
    try {
      const resolved = currentRequestIdentity(epoch);
      if (!resolved) return;
      const response = await postGroupsBody(groupsUrl(), { token: resolved.identity.token });
      if (!current()) return;
      if (!response.ok) {
        await adoptSignedOutVerdict(response, resolved.epoch);
        if (current()) useGroupsStore.setState((state) => ({ phase: 'failed', groups: state.groups }));
        return;
      }
      const answer = parseGroups(await response.json());
      // Fenced: an answer that outlived its identity describes an account this device no
      // longer acts as.
      if (!current()) return;
      loadedFor = identity.accountId;
      useGroupsStore.setState({ phase: 'ready', groups: answer.groups });
    } catch {
      if (current()) useGroupsStore.setState((state) => ({ phase: 'failed', groups: state.groups }));
    } finally {
      if (generation === requestGeneration) flight = null;
    }
  })();
}

// A write answered with the list as it now stands: publish it for the account it is about.
export function adoptGroups(answer: GroupsAnswer, accountId: string): void {
  if (deviceIdentity()?.accountId !== accountId) return;
  generation += 1;
  flight = null;
  loadedFor = accountId;
  useGroupsStore.setState({ phase: 'ready', groups: answer.groups });
}

export function useGroups(): GroupsState {
  return useGroupsStore((state) => state);
}

// Registered in `identityScope`: the list belongs to the ACCOUNT.
export function resetGroups(): void {
  generation += 1;
  flight = null;
  loadedFor = null;
  useGroupsStore.setState({ phase: 'idle', groups: null });
}
