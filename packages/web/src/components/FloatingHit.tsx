import { useEffect } from 'react';
import type { CSSProperties } from 'react';

export const HIT_FADE_MS = 520;

// Floating indicator shown over a hole on a guess: the distance number when the
// word is in the hole's rank map, or "MISS" when it was too far. It springs in,
// then rises and fades out — see `.floating-hit` in index.css. `color` is supplied
// by Hole (warm = heat of the distance, MISS = coldest heat).
export default function FloatingHit({
  id,
  value,
  color,
  startDelayMs,
  fadeDelayMs,
  miss = false,
  onDone,
}: {
  id: number; // identifies this hit so the parent can clear it (multi-hit safe)
  value: number;
  color: string;
  startDelayMs: number;
  fadeDelayMs: number;
  miss?: boolean; // too far for this hole -> "MISS" instead of a distance
  onDone?: (id: number) => void;
}) {
  useEffect(() => {
    const t = setTimeout(() => onDone && onDone(id), fadeDelayMs + HIT_FADE_MS);
    return () => clearTimeout(t);
  }, [fadeDelayMs, id, onDone]);

  const style: CSSProperties & Record<'--hit-delay' | '--hit-fade-delay', string> = {
    color,
    '--hit-delay': `${startDelayMs}ms`,
    '--hit-fade-delay': `${fadeDelayMs}ms`,
  };

  return (
    <span className="floating-hit" style={style}>
      {miss ? 'MISS' : value === 0 ? '0' : `-${value}`}
    </span>
  );
}
