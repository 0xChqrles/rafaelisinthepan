import { useEffect } from 'react';
import { roundLoadFor, useGameStore, type RoundLoad } from '../state/gameStore';
import { beginWordRoundSync, wordTag, type WordRoundContext } from '../state/wordRoundSync';

// React binding for Word mode's round conversation (#202, state/wordRoundSync.ts):
// registers the round's context on mount and refreshes it if the artifact changes. All
// state lives in the engine's module-level map, so this hook deliberately has none:
// remounts (archive round-trips, StrictMode's replay) rejoin the same conversation instead
// of minting a second one.
//
// Two acts are NOT here, because both are the SCREEN's own. PLAY is an act with an answer
// the gate waits on, so it calls `startWordRound` directly and awaits it. And the run's END
// is reported with `finishWordRound` (#217): the deadline is a wall-clock fact, and whether
// this device HOLDS the run is the server's stamp read against this device's id — the same
// two facts the screen picks its phase from, so the report belongs where that decision is
// made rather than as a prop passed down into the engine.
//
// It also reports WHERE the round's authoritative state is (#214): a reload waits for the
// mount read before the run UI resumes, exactly as the sentence board does — which is also
// what stops PLAY being tappable while that read is still in flight, since a start creates
// server state and the answer is what says whose run it now is.
export default function useWordRoundSync(ctx: WordRoundContext): RoundLoad {
  const { roundKey, lang, date, word, ranks } = ctx;
  useEffect(() => {
    beginWordRoundSync({ roundKey, lang, date, word, ranks });
  }, [roundKey, lang, date, word, ranks]);
  const load = useGameStore((s) => s.roundLoads[roundKey]);
  return roundLoadFor(load, wordTag(word));
}
