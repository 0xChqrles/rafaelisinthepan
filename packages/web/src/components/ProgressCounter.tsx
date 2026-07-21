import useAnimatedNumber from '../hooks/useAnimatedNumber';
import { progressColor } from '@whippin/shared';

// The reconstruction progress as a floating arcade-style counter (top-left of the
// screen, the classic "SCORE" corner) — replacing the old full-width progress bar
// (decided 2026-07-21): the VALUE carries the length and the ramp COLOR carries the
// feel, so the number alone says everything the bar did in a fraction of the space.
// Semantics stay a progressbar (aria value attrs); the animated display number is
// decorative easing, the aria value is the real one.
export default function ProgressCounter({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const display = useAnimatedNumber(pct);

  return (
    <div
      className="progress-counter"
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      style={{ color: progressColor(pct) }}
    >
      {Math.round(display)}%
    </div>
  );
}
