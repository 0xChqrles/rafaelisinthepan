import { useEffect } from 'react';
import { roundLoadFor, useGameStore, type RoundLoad } from '../state/gameStore';
import { beginRoundSync, type RoundSyncContext } from '../state/roundSync';

// React binding for the round sync engine (state/roundSync.ts): registers the round's
// context on mount, refreshes it if the puzzle props change, and reports back WHERE that
// round's authoritative state is — which since #214 the screen waits on before it becomes
// interactive. All state lives in the engine's module-level conversation map and the
// store's transient `roundLoads`, so this hook deliberately has none: remounts (archive
// round-trips, StrictMode's replay) rejoin the same conversation instead of minting a
// second one.
//
// 'loading' rather than the store's `undefined` on the first render: the effect that
// registers the round has not run yet, and an absent entry means exactly the same thing —
// nothing has been read.
export default function useRoundSync(ctx: RoundSyncContext): RoundLoad {
  const { roundKey, lang, mode, date, revision, ranks } = ctx;
  useEffect(() => {
    beginRoundSync({ roundKey, lang, mode, date, revision, ranks });
  }, [roundKey, lang, mode, date, revision, ranks]);
  const load = useGameStore((s) => s.roundLoads[roundKey]);
  return roundLoadFor(load, revision);
}
