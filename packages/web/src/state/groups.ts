// The player's GROUPS (#271), as every surface that draws them needs them: the leaderboard's
// tabs, the global board's member marks, the invite landing's "already a member", the play
// screen's question "is there anybody to race?" (the live read's eligibility,
// state/liveBoard.ts) and the result's SEAT all read ONE answer to "which groups am I in".
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

type GroupsPhase = 'idle' | 'loading' | 'ready' | 'failed';

interface GroupsState {
  phase: GroupsPhase;
  // The groups this device's account is in, or null while unknown. `phase: 'ready'` with
  // an empty list is an ANSWER — no groups — for a tokenless device and a deployed one alike.
  groups: GroupSummary[] | null;
}

export const useGroupsStore = create<GroupsState>(() => ({ phase: 'idle', groups: null }));

// ONE flight per account, the `activeScoreFlights` pattern.
let flight: Promise<boolean> | null = null;
let loadedFor: string | null = null;
let generation = 0;

// Refresh on each surface entry, keeping a previous answer visible while it loads. It settles
// when the read does (the flight already out, if one is), TRUE when that read published the
// list as the server holds it — false when it failed, stood down, or was overtaken.
// `fresh`: a read SENT NOW, never the flight already out, which may have left before a write
// — what a write whose outcome is unknown waits on before it says anything
// (`state/groupActs.ts`); the flight it overtakes publishes nothing.
export function loadGroups(options: { fresh?: boolean } = {}): Promise<boolean> {
  const identity = deviceIdentity();
  if (identity === null) {
    loadedFor = null;
    useGroupsStore.setState({ phase: 'ready', groups: [] });
    return Promise.resolve(true);
  }
  if (flight && !options.fresh) return flight;
  if (flight) generation += 1;
  const epoch = identityEpochOf(identity);
  const requestGeneration = generation;
  const current = () => generation === requestGeneration && currentRequestIdentity(epoch) !== null;
  useGroupsStore.setState((state) => ({
    phase: 'loading',
    // Keep a list already in hand while a refresh is out — the leaderboard's
    // stale-but-good rule.
    groups: loadedFor === identity.accountId ? state.groups : null,
  }));
  const read = (async () => {
    try {
      const resolved = currentRequestIdentity(epoch);
      if (!resolved) return false;
      const response = await postGroupsBody(groupsUrl(), { token: resolved.identity.token });
      if (!current()) return false;
      if (!response.ok) {
        await adoptSignedOutVerdict(response, resolved.epoch);
        if (current()) useGroupsStore.setState((state) => ({ phase: 'failed', groups: state.groups }));
        return false;
      }
      const answer = parseGroups(await response.json());
      // Fenced: an answer that outlived its identity describes an account this device no
      // longer acts as.
      if (!current()) return false;
      loadedFor = identity.accountId;
      useGroupsStore.setState({ phase: 'ready', groups: answer.groups });
      return true;
    } catch {
      if (current()) useGroupsStore.setState((state) => ({ phase: 'failed', groups: state.groups }));
      return false;
    } finally {
      if (generation === requestGeneration) flight = null;
    }
  })();
  flight = read;
  return read;
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

// "Is there anybody in my groups but me?" — the ONE reading of it, off the list as held: the
// play screen's race line runs only when there is (the live read's eligibility), and the
// result's SEAT stands only when there is not. A list not known yet holds nobody it can name.
export function holdsSomebody(groups: readonly { members: readonly string[] }[] | null): boolean {
  return groups?.some((group) => group.members.length > 1) ?? false;
}

// Registered in `identityScope`: the list belongs to the ACCOUNT.
export function resetGroups(): void {
  generation += 1;
  flight = null;
  loadedFor = null;
  useGroupsStore.setState({ phase: 'idle', groups: null });
}
