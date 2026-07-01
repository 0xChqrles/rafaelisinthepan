import useAnimatedNumber from '../hooks/useAnimatedNumber';
import { progressColor } from '../game/progressColor';

export default function ProgressBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const display = useAnimatedNumber(pct);
  const fill = progressColor(pct);
  const text = `${Math.round(display)}%`;

  return (
    <div className="progress-wrap">
      <div
        className="progress"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="progress-fill"
          style={{ width: `${pct}%`, background: fill }}
        />
        {/* Two aligned copies of the % centered on the bar. Base = fill color, seen over
            the empty track. Overlay = track color, clipped to the filled region so it
            shows over the fill — the number flips color exactly at the fill edge. Both are
            decorative; the value is exposed via role="progressbar" above. */}
        <span className="progress-label" style={{ color: fill }} aria-hidden="true">
          {text}
        </span>
        <span
          className="progress-label progress-label-on-fill"
          style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}
          aria-hidden="true"
        >
          {text}
        </span>
      </div>
    </div>
  );
}
