import { useEffect } from 'react';
import type { CSSProperties } from 'react';

// How long the label takes to leave once its hold is up. The JS mirror of
// `rarity-vanish`'s duration in index.css, and what the screen adds to a hit's hold to know
// when the thing is actually gone.
export const RARITY_VANISH_MS = 600;

// Word mode's guess feedback (#163): the claim's RARITY GRADE, or MISS, stamped onto the
// day's word.
//
// It is NOT the sentence game's floating exponent and does not share its animation (decided
// 2026-08-09). That one pops UP off the word and drifts away as a footnote to it — right for
// a distance, which is a remark about the word. A grade is not a remark, it is a VERDICT on
// the guess: so this one falls onto the word from above, LANDS on it, sits there long enough
// to be read, and then leaves straight up. Same delay contract, same unmount timer, nothing
// else in common — which is why the two are two components (`FloatingHit` is the other).
export default function RarityHit({
  id,
  label,
  color,
  scale,
  drop,
  rise,
  punch,
  tilt,
  fadeDelayMs,
  onDone,
}: {
  id: number; // monotonic, so a guess landing mid-hit remounts and restarts the animation
  label: string; // the grade, or MISS
  color: string;
  // The intensity dimensions, straight off components/rarity.ts RARITY_HIT: the type size
  // as a multiple of the surface's `--hit-base`, how far above the word it falls FROM, how
  // far it flies when it leaves, the scale it arrives at, and the angle it lands at.
  scale: number;
  drop: number;
  rise: number;
  punch: number;
  tilt: number;
  fadeDelayMs: number; // how long it SITS on the word before leaving — rarity buys hold
  onDone?: (id: number) => void;
}) {
  useEffect(() => {
    const t = setTimeout(() => onDone && onDone(id), fadeDelayMs + RARITY_VANISH_MS);
    return () => clearTimeout(t);
  }, [fadeDelayMs, id, onDone]);

  const style: CSSProperties &
    Record<
      | '--hit-fade-delay'
      | '--hit-scale'
      | '--hit-drop'
      | '--hit-rise'
      | '--hit-punch'
      | '--hit-tilt'
      | '--hit-len',
      string
    > = {
    color,
    '--hit-fade-delay': `${fadeDelayMs}ms`,
    '--hit-scale': String(scale),
    '--hit-drop': `${drop}px`,
    '--hit-rise': `${rise}px`,
    '--hit-punch': String(punch),
    '--hit-tilt': `${tilt}deg`,
    // How many glyphs wide this is. The pixel font advances exactly 1em per glyph, so the
    // CSS can cap the size at what the column holds — the same arithmetic `fitWord` does,
    // and the reason a 2.6x ARCANE cannot run off a phone.
    '--hit-len': String(Math.max(1, label.length)),
  };

  return (
    <span className="rarity-hit" style={style}>
      {label}
    </span>
  );
}
