// How good a result was is the BOT's judgement, never the model's (#236). One set of
// thresholds answers it, and both acknowledgements read from here: `react` turns the band
// into an emoji, `say` hands the band to the model as a settled verdict it may dress in
// words but never revise. Two ladders would let the emoji and the line disagree about the
// same score in the same group on the same day.
//
// THE LADDER STARTS AT 3 (user-corrected 2026-09-04). A sentence hides three words, so
// three tries is the FLOOR — the only perfect score there is, not merely a very good one —
// and anything under ten is good play. The first cut was written as though 0 were
// reachable: `<= 3` as the top band made the best reaction unreachable except by a flawless
// game, and it called a 12 `ordinary` when a 12 is nothing of the sort.
//
// The recorded scores agree with where the good half ends: 76 sentence rows (2026-09-04)
// give min 3, p25 9, median 14, p75 23, max 49 — so "under ten" is almost exactly the top
// quartile. The cuts are the PRODUCT's, not the distribution's; the sample is small and
// pre-launch, and it is quoted here as support rather than as the reason.

export const MIN_POSSIBLE_SCORE = 3; // three secrets, one try each

export type ScoreBand = 'perfect' | 'brilliant' | 'strong' | 'ordinary' | 'laboured' | 'failed';

export function scoreBand(score: number, capped: boolean): ScoreBand {
  if (capped) return 'failed';
  if (score <= MIN_POSSIBLE_SCORE) return 'perfect';
  if (score <= 6) return 'brilliant';
  if (score <= 9) return 'strong'; // still good play — the band must never read as a rebuke
  if (score <= 19) return 'ordinary';
  return 'laboured';
}

const EMOJI: Record<ScoreBand, string> = {
  perfect: '💯',
  brilliant: '🔥',
  strong: '👏',
  ordinary: '👍',
  laboured: '🫡',
  failed: '💀',
};

export function reactionFor(score: number, capped: boolean): string {
  return EMOJI[scoreBand(score, capped)];
}
