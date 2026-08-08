import { useEffect } from 'react';
import type { CSSProperties } from 'react';

// The three numbers the stamp's choreography is built out of, and the JS mirrors of what
// index.css does with them. They are here rather than only in the CSS because the WORD's own
// reaction has to be timed against them: the shake and the letter wave must fire at the
// moment of IMPACT, not when the label mounts, or the word flinches before anything hits it.
export const RARITY_STAMP_MS = 300; // fall + land + settle
// Where in that the label actually LANDS. Must match the impact keyframe's percentage in
// `rarity-stamp` — the one place these two files have to agree.
const RARITY_IMPACT_AT = 0.45;
export const RARITY_IMPACT_MS = Math.round(RARITY_STAMP_MS * RARITY_IMPACT_AT);
// How long it takes to leave once its hold is up.
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
