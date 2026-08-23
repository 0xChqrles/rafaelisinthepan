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
import { useGameStore } from './gameStore';
import { resetPlayerHistory } from './history';
import { resetRoundSync } from './roundSync';
import { resetWordRoundSync } from './wordRoundSync';

export function installIdentityScope(): () => void {
  return onIdentityChange(({ previous, accountChanged, deviceChanged }) => {
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
    if (previous === null) return;

    // Word mode's clock and its unsubmitted log are DEVICE-owned: a run belongs to the
    // device playing it (its bonus-adjusted deadline lives nowhere else until submission),
    // so a new device never inherits one.
    if (deviceChanged) {
      resetWordRoundSync();
      useGameStore.setState({ wordRounds: {}, activeWordKey: null });
    }
    if (!accountChanged) return;
    // ACCOUNT-owned: the sentence outbox (guesses owed to a server row keyed by the
    // account), the transient round snapshots read off it, and the private summaries the
    // archive, the chooser and the streak draw.
    resetRoundSync();
    resetPlayerHistory();
    useGameStore.setState({ outbox: {}, roundLoads: {} });
  });
}
