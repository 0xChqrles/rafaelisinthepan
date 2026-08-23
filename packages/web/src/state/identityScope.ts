// Local state follows the identity that owns it (#216).
//
// Every value this app keeps is scoped to somebody: a round's outbox, the transient server
// snapshots, the private history and the streak all belong to an ACCOUNT, while Word mode's
// clock and its unsubmitted log belong to a DEVICE. When the identity changes — a first
// bootstrap, a sign-out, a fresh start — whatever the previous one owned has to go, or the
// new identity inherits a stranger's board.
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
  return onIdentityChange(({ accountChanged, deviceChanged }) => {
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
