import { useEffect } from 'react';
import { useGameStore, type RoundLoad } from '../state/gameStore';
import { beginWordRoundSync, type WordRoundContext } from '../state/wordRoundSync';

// React binding for Word mode's round conversation (#202, state/wordRoundSync.ts):
// registers the round's context on mount, refreshes it if the artifact changes, and tells
// the engine when the run is OVER — the one fact a log cannot see for itself, and what asks
// for the single end-of-run write. All state lives in the engine's module-level map, so
// this hook deliberately has none: remounts (archive round-trips, StrictMode's replay)
// rejoin the same conversation instead of minting a second one.
//
// PLAY is NOT here: starting a run is an ACT with an answer the gate waits on, so the
// screen calls `startWordRound` directly and awaits it.
// It also reports WHERE the round's authoritative state is (#214): a reload waits for the
// mount read before the run UI resumes, exactly as the sentence board does — which is also
// what stops PLAY being tappable while that read is still in flight, since a session that
// starts a run it cannot see becomes its writer.
export default function useWordRoundSync(ctx: WordRoundContext, over: boolean): RoundLoad {
  const { roundKey, lang, date, word, ranks, corpusSize } = ctx;
  useEffect(() => {
    beginWordRoundSync({ roundKey, lang, date, word, ranks, corpusSize }, over);
  }, [roundKey, lang, date, word, ranks, corpusSize, over]);
  return useGameStore((s) => s.roundLoads[roundKey]) ?? LOADING;
}

const LOADING: RoundLoad = { status: 'loading' };
