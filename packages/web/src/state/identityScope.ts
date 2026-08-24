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
import { reconcileGameStateIdentity } from './gameStore';
import { rearmPlayerHistory, resetPlayerHistory } from './history';
import { kickRoundSync, rearmRoundSync, resetRoundSync } from './roundSync';
import { rearmWordRoundSync, resetWordRoundSync } from './wordRoundSync';

export function installIdentityScope(): () => void {
  return onIdentityChange(({ previous, next, accountChanged, deviceChanged, adopted }) => {
    // **Acquiring a FIRST identity clears nothing.** A bootstrap is triggered BY an act —
    // the first guess, a word round start — so the state on screen when it lands is the
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
        // An identity ADOPTED from another tab is not the minted-empty bootstrap: the
        // tokenless projections published while this tab had no token — the ready-and-empty
        // round, the empty months and collection — may be wrong about the account it now
        // acts as, and nothing else re-reads them (no scope bump on a first acquisition, so
        // no remount; the flights and the caches survive remounts anyway). RE-ARM the
        // reads, never clear: the outbox and the word clock still hold what THIS device
        // played, and it is owed to the adopted account.
        if (adopted) {
          rearmRoundSync();
          rearmWordRoundSync();
          rearmPlayerHistory();
        } else {
          // MINTED by a deploy button: nothing to re-read (the account is empty by
          // construction), but an outbox that was waiting behind the PLAY gate — the
          // pending-bootstrap recovery — is owed the moment the identity exists, and the
          // append never mints its own any more (#216 trigger rework).
          kickRoundSync();
        }
      }
      return;
    }

    // Word mode's clock and its unsubmitted log are DEVICE-owned: a run belongs to the
    // device playing it (its bonus-adjusted deadline lives nowhere else until submission),
    // so a new device never inherits one.
    if (deviceChanged) {
      resetWordRoundSync();
    }
    if (accountChanged) {
      // ACCOUNT-owned: the sentence outbox (guesses owed to a server row keyed by the
      // account), the transient round snapshots read off it, and the private summaries the
      // archive, the chooser and the streak draw.
      resetRoundSync();
      resetPlayerHistory();
    }
    // One state write owns the persisted owner tag and the selective map clearing. It is
    // also the first-acquisition bind above, where the triggering act must survive.
    reconcileGameStateIdentity(next);
  });
}
