// Reactions do not need intelligence (#236): a valid share may get one deterministic
// WhatsApp reaction, chosen from the score alone, and nothing is ever posted after an
// ordinary share. The first version stays quiet on purpose — acknowledge, do not comment.

export function reactionFor(score: number, capped: boolean): string {
  if (capped) return '💀';
  if (score <= 3) return '🔥';
  if (score <= 6) return '👏';
  if (score <= 12) return '👍';
  return '🫡';
}
