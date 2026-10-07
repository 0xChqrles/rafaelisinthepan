import { useEffect, useLayoutEffect } from 'react';
import { roundLoadFor, useGameStore, type RoundLoad } from '../state/gameStore';
import { beginRoundSync, type RoundSyncContext } from '../state/roundSync';

// React binding for the round sync engine (state/roundSync.ts), held by the GAME ROUTE: it
// reconciles the round's outbox, registers the round's context once the puzzle is in, and
// reports back WHERE that round's authoritative state is — which since #214 the screen
// waits on before it becomes interactive (the route's hold stands until it is `ready`). All
// state lives in the engine's module-level conversation map and the store's transient
// `roundLoads`, so this hook deliberately has none: remounts (archive round-trips,
// StrictMode's replay) rejoin the same conversation instead of minting a second one.
//
// Idle (null) until there is a round to sync — the puzzle not in yet. 'loading' rather than
// the store's `undefined` on the first render: the effect that registers the round has not
// run yet, and an absent entry means exactly the same thing — nothing has been read.
export default function useRoundSync(ctx: RoundSyncContext | null): RoundLoad | null {
  const roundKey = ctx?.roundKey;
  const lang = ctx?.lang;
  const date = ctx?.date;
  const revision = ctx?.revision;
  const ranks = ctx?.ranks;
  const ensureOutbox = useGameStore((s) => s.ensureOutbox);
  // Reconcile the OUTBOX before paint, and before the read below (#214): an outbox naming a
  // different published revision answered a retired question and is dropped. A layout
  // effect commits that before the browser paints, so a retired round's guesses never reach
  // a render.
  useLayoutEffect(() => {
    if (roundKey !== undefined && revision !== undefined) ensureOutbox(roundKey, revision);
  }, [ensureOutbox, roundKey, revision]);
  useEffect(() => {
    if (roundKey === undefined || lang === undefined || date === undefined || revision === undefined || !ranks) {
      return;
    }
    beginRoundSync({ roundKey, lang, date, revision, ranks });
  }, [roundKey, lang, date, revision, ranks]);
  const load = useGameStore((s) => (roundKey === undefined ? undefined : s.roundLoads[roundKey]));
  return revision === undefined ? null : roundLoadFor(load, revision);
}
