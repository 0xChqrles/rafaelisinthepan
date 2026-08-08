import { useEffect } from 'react';
import type { CSSProperties } from 'react';

export const HIT_FADE_MS = 520;

// What the float did before Word mode had grades, and therefore what every optional knob
// below defaults to. Stated here rather than left implicit in the CSS, because "the
// sentence game renders exactly as it always did" is the contract these defaults exist to
// keep, and a default nobody can see is a contract nobody can check.
const DEFAULT_LIFT = 14; // px above the word's centre where the label comes to rest
const DEFAULT_RISE = 42; // px the label drifts up as it fades
const DEFAULT_PUNCH = 1.35; // the pop's peak scale
const DEFAULT_TILT = 0; // degrees the label rests at — dead straight, as it always was

// Floating indicator shown over a word on a guess. The SENTENCE game uses it for the
// distance number (or "MISS") — see `.floating-hit` in index.css; `color` is supplied by
// Hole (warm = heat of the distance, MISS = coldest heat).
//
// WORD MODE (#163) prints a `label` instead — the claim's RARITY grade, or MISS — and
// scales the three dimensions below with it, so ARCANE lands harder than COMMON. All four
// are OPTIONAL and default to today's render, which is the point: this is ONE float with
// ONE animation, and the sentence board must not acquire a rarity concept it does not
// have. Passing none of them is byte-identical to what it did before.
export default function FloatingHit({
  id,
  value,
  color,
  startDelayMs,
  fadeDelayMs,
  miss = false,
  label,
  scale = 1,
  lift = DEFAULT_LIFT,
  rise = DEFAULT_RISE,
  punch = DEFAULT_PUNCH,
  tilt = DEFAULT_TILT,
  onDone,
}: {
  id: number; // identifies this hit so the parent can clear it (multi-hit safe)
  value: number;
  color: string;
  startDelayMs: number;
  fadeDelayMs: number;
  miss?: boolean; // too far for this hole -> "MISS" instead of a distance
  // What to print, when it is not a distance at all: Word mode's rarity grade, or MISS.
  label?: string;
  // How hard it lands. A multiplier on the surface's own `--hit-base` type size (so a
  // breakpoint can shrink every grade at once), where it rests above the word, the fade's
  // travel in px, and the pop's peak scale. The values live in ONE table beside the ladder they escalate with —
  // components/rarity.ts RARITY_HIT — never in the styling.
  scale?: number;
  lift?: number;
  rise?: number;
  punch?: number;
  // The angle it comes to rest at. Word mode rolls a random one per hit; the entry and
  // overshoot rotations stay RELATIVE to it, so a zero default reproduces the straight
  // label the sentence game has always thrown.
  tilt?: number;
  onDone?: (id: number) => void;
}) {
  useEffect(() => {
    const t = setTimeout(() => onDone && onDone(id), fadeDelayMs + HIT_FADE_MS);
    return () => clearTimeout(t);
  }, [fadeDelayMs, id, onDone]);

  const text = label ?? (miss ? 'MISS' : value === 0 ? '0' : `-${value}`);

  const style: CSSProperties &
    Record<
      | '--hit-delay'
      | '--hit-fade-delay'
      | '--hit-scale'
      | '--hit-lift'
      | '--hit-rise'
      | '--hit-punch'
      | '--hit-tilt'
      | '--hit-len',
      string
    > = {
    color,
    '--hit-delay': `${startDelayMs}ms`,
    '--hit-fade-delay': `${fadeDelayMs}ms`,
    '--hit-scale': String(scale),
    '--hit-lift': `${lift}px`,
    '--hit-rise': `${rise}px`,
    '--hit-punch': String(punch),
    '--hit-tilt': `${tilt}deg`,
    // How many glyphs wide this is. The pixel font advances exactly 1em per glyph, so the
    // CSS can cap the size at what the column holds — the same arithmetic `fitWord` does,
    // and the reason a 2.6x ARCANE cannot run off a phone. Harmless where no surface
    // declares a `--hit-room` to cap against, which is every surface but Word mode's.
    '--hit-len': String(Math.max(1, text.length)),
  };

  return (
    <span className="floating-hit" style={style}>
      {text}
    </span>
  );
}
