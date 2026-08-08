import { useEffect } from 'react';
import type { CSSProperties } from 'react';

// Word mode's guess feedback (#163): the claim's RARITY GRADE, or MISS, shown on the day's
// word.
//
// IT DOES NOT ANIMATE (decided 2026-08-09). Several choreographies were tried here — a
// pop, a stamp falling onto the word, a shockwave through the letters — and all of them
// were rejected. What is left is deliberately the plain thing: the label appears at its
// size, its colour and its place, stays for as long as its grade earns, and goes. Anything
// added back should be added on purpose, on top of a baseline that is doing nothing.
//
// (`FloatingHit` is the SENTENCE game's animated distance number, untouched by any of this.)
export default function RarityHit({
  id,
  label,
  color,
  scale,
  holdMs,
  onDone,
}: {
  id: number; // monotonic, so a new guess replaces the one on screen
  label: string; // the grade, or MISS
  color: string;
  // The type size, as a multiple of the surface's `--hit-base`. Straight off
  // components/rarity.ts RARITY_HIT — a static size, nothing animated.
  scale: number;
  holdMs: number; // how long it stays; rarer grades stay longer
  onDone?: (id: number) => void;
}) {
  useEffect(() => {
    const t = setTimeout(() => onDone && onDone(id), holdMs);
    return () => clearTimeout(t);
  }, [holdMs, id, onDone]);

  const style: CSSProperties & Record<'--hit-scale' | '--hit-len', string> = {
    color,
    '--hit-scale': String(scale),
    // How many glyphs wide this is. The pixel font advances exactly 1em per glyph, so the
    // CSS can cap the size at what the column holds — the same arithmetic `fitWord` does,
    // and what keeps a long grade name off the edge of a phone.
    '--hit-len': String(Math.max(1, label.length)),
  };

  return (
    <span className="rarity-hit" style={style}>
      {label}
    </span>
  );
}
