// How good a result was is the BOT's judgement, never the model's (#236). One set of
// thresholds answers it, and both acknowledgements read from here: `react` turns the band
// into an emoji, `say` hands the band to the model as a settled verdict it may dress in
// words but never revise. Two ladders would let the emoji and the line disagree about the
// same score in the same group on the same day.

export type ScoreBand = 'brilliant' | 'strong' | 'ordinary' | 'laboured' | 'failed';

export function scoreBand(score: number, capped: boolean): ScoreBand {
  if (capped) return 'failed';
  if (score <= 3) return 'brilliant';
  if (score <= 6) return 'strong';
  if (score <= 12) return 'ordinary';
  return 'laboured';
}

const EMOJI: Record<ScoreBand, string> = {
  brilliant: '🔥',
  strong: '👏',
  ordinary: '👍',
  laboured: '🫡',
  failed: '💀',
};

export function reactionFor(score: number, capped: boolean): string {
  return EMOJI[scoreBand(score, capped)];
}
