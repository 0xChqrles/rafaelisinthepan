// EARLY PLAY (#273, user-decided 2026-09-08): tomorrow's sentence opens tonight, and the
// night's play ends at the FIRST PROGRESS — a guess that beats a start word, an exact hit
// included — or after `EARLY_GUESS_CAP` guesses, whichever comes first. The server refuses
// the append after that point (`early_locked`, inside the append's own condition); the
// client reads the same two facts off its own play log and locks its input the moment
// either holds, so the refusal is never what the player learns it from.
//
// Progress is the SHARED reading: `holeProgress > 0` on any hole, which `computeProgress`
// averages — an average of non-negative terms is above 0 exactly when one of them is.

import { EARLY_GUESS_CAP, type RankMap, type RuntimeHole } from '@whippin/shared';
import { computeProgress, replayHoles } from './scoring';

export function earlyLocked(
  freshHoles: RuntimeHole[],
  ranks: RankMap,
  playLog: readonly string[],
): boolean {
  if (playLog.length >= EARLY_GUESS_CAP) return true;
  if (playLog.length === 0) return false;
  return computeProgress(replayHoles(freshHoles, ranks, playLog), ranks) > 0;
}
