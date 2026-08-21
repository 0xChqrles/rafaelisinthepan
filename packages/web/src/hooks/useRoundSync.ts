import { useEffect } from 'react';
import { beginRoundSync, type RoundSyncContext } from '../state/roundSync';

// React binding for the #201 round sync engine (state/roundSync.ts): registers the
// round's context on mount and refreshes it if the puzzle props change. All state lives
// in the engine's module-level conversation map, so this hook deliberately has none —
// remounts (archive round-trips, StrictMode's replay) rejoin the same conversation
// instead of minting a second one.
export default function useRoundSync(ctx: RoundSyncContext): void {
  const { roundKey, lang, mode, date, ranks, freshHoles } = ctx;
  useEffect(() => {
    beginRoundSync({ roundKey, lang, mode, date, ranks, freshHoles });
  }, [roundKey, lang, mode, date, ranks, freshHoles]);
}
