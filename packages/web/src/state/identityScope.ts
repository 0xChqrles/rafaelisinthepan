// Local state follows the identity that owns it (#216).
//
// Every value this app keeps is scoped to somebody: a round's outbox, the transient server
// snapshots, the private history and the streak all belong to an ACCOUNT, while Word mode's
// clock and its unsubmitted log belong to a DEVICE. When a held identity is LEFT — a sign-out,
// a fresh start, an account swap — whatever it owned has to go, or the new identity inherits
// a stranger's board. The first bootstrap is deliberately different: there is no previous
// owner, and the local act that triggered it must survive (see the listener below).
//
// Clearing storage is only half of it. In-flight private requests capture the identity
// EPOCH and drop an answer that outlives it (`identityEpoch`, read by the round engines and
// the history cache), so the identity just left cannot repopulate the one that replaced it
// a moment after this ran.
//
// It lives HERE, wired once from `main.tsx`, rather than as import-time side effects inside
// each module: `identity.ts` then keeps knowing nothing about the game, and the whole list
// of what an identity owns is one readable block instead of five registrations to find.

import { onIdentityChange } from '../identity';
import { resetAccountSummary } from './account';
import { reconcileGameStateIdentity } from './gameStore';
import { rearmPlayerHistory, resetPlayerHistory } from './history';
import { kickRoundSync, rearmRoundSync, resetRoundSync } from './roundSync';
import { kickWordRoundSync, rearmWordRoundSync, resetWordRoundSync } from './wordRoundSync';

export function installIdentityScope(): () => void {
  return onIdentityChange(({ previous, next, accountChanged, deviceChanged, adopted }) => {
    // **Acquiring a FIRST identity clears nothing.** A bootstrap is triggered BY a deploy
    // button — a PLAY, an invite, a save — so the state on screen when it lands is the
    // state that ASKED for it: the guess sitting in the outbox waiting to be sent, the run
    // whose PLAY is awaiting its answer. Clearing there orphaned the sentence append (later
    // guesses then never synced) and wiped `wordRounds` out from under the start's own
    // "is this still the word I asked about?" guard, so a fresh player could not reliably
    // begin a word round at all.
    //
    // Clearing is about LEAVING an identity, and there is nothing to leave when the previous
    // one was null: whatever local state exists then was typed by this player, on this
    // device, and is owed to the account they are about to be given.
    if (previous === null) {
      if (next !== null) {
        reconcileGameStateIdentity(next);
        // An ADOPTED identity is not the minted-empty bootstrap — another tab's account,
        // or a pending bootstrap RECOVERED from storage, whose original acts may have run
        // before its identity write failed (PR-219 round-2 review). The tokenless
        // projections published while this tab had no token — the ready-and-empty round,
        // the empty months and collection — may be wrong about the account it now acts
        // as, and nothing else re-reads them (no scope bump on a first acquisition, so no
        // remount; the flights and the caches survive remounts anyway). RE-ARM the reads,
        // never clear: the outbox and the word clock still hold what THIS device played,
        // and it is owed to the adopted account.
        if (adopted) {
          rearmRoundSync();
          rearmWordRoundSync();
          rearmPlayerHistory();
        } else {
          // MINTED by a deploy button: nothing to re-read (the account is empty by
          // construction), but what was WAITING for an identity is owed the moment one
          // exists, and neither engine mints its own any more (#216 trigger rework): the
          // sentence outbox parked behind the PLAY gate, and an ended word run's
          // unsubmitted log — the pending-bootstrap recovery in both engines.
          kickRoundSync();
          kickWordRoundSync();
        }
      }
      return;
    }

    // Word mode's clock and its unsubmitted log belong to this (account, device) start: a
    // new device cannot inherit its local deadline, and a device re-parented to another
    // account cannot submit a start the old account owns.
    if (accountChanged || deviceChanged) {
      resetWordRoundSync();
    }
    if (accountChanged) {
      // ACCOUNT-owned: the sentence outbox (guesses owed to a server row keyed by the
      // account), the transient round snapshots read off it, the private summaries the
      // archive, the chooser and the streak draw — and (#204) what the account screen says
      // this account IS, since a device that leaves one may not keep showing its address.
      resetRoundSync();
      resetPlayerHistory();
      resetAccountSummary();
    }
    // One state write owns the persisted owner tag and the selective map clearing. It is
    // also the first-acquisition bind above, where the triggering act must survive.
    reconcileGameStateIdentity(next);
  });
}
