import { prefersReducedMotion } from '../hooks/useScramble';

// THE REFUSAL, in the house's hard steps: what cannot be done answers the way an invalid guess
// does — it shakes — here on whole 2px cells, three held frames of 40ms (never an eased glide):
// the archive's month chip pushed past either end, a device line whose sign-out did not land.
const REFUSE_SHAKE: Keyframe[] = [
  { translate: '-2px 0', offset: 0, easing: 'steps(1, end)' },
  { translate: '2px 0', offset: 0.25, easing: 'steps(1, end)' },
  { translate: '-2px 0', offset: 0.5, easing: 'steps(1, end)' },
  { translate: '0 0', offset: 0.75 },
  { translate: '0 0', offset: 1 },
];
const REFUSE_SHAKE_MS = 160;

export function refuseShake(el: Element | null | undefined): void {
  if (!el || prefersReducedMotion()) return;
  el.animate?.(REFUSE_SHAKE, { duration: REFUSE_SHAKE_MS });
}
