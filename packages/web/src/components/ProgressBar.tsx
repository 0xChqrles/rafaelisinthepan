import useAnimatedNumber from '../hooks/useAnimatedNumber';
import { progressColor } from '../game/progressColor';

export default function ProgressBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const display = useAnimatedNumber(pct);

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
          style={{ width: `${pct}%`, background: progressColor(pct) }}
        />
        {/* Centered over the bar; a difference blend keeps it legible over both the
            fill and the empty track (see .progress-label in index.css). */}
        <span className="progress-label">{Math.round(display)}%</span>
      </div>
    </div>
  );
}
