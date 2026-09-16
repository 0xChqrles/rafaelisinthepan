import { useEffect, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { rankHeatColor } from '@whippin/shared';

// The LOOT a hit knocks out of a game word (#301, user-decided 2026-09-15, "the same exponent
// animation"): the guess's rank exponent pops off the cut hole like a drop off a hit enemy —
// up on the impact, a hang at the top of the throw, then the fall — so the number the screen
// does not park is said for exactly the moment it is news, and is gone before the next guess
// needs the screen. The strike stays what it was; this is what the hit shakes loose.
//
// The exponent is written the one way the app writes ranks, in the heat colour every other
// exponent wears (the shared `rankHeatColor`).
//
// THE THROW IS ROLLED PER HIT (decided 2026-08-10): which side it flies to, and a small
// jitter on its distance, height, drop and tilt. Loot that flew the identical arc on every
// hit read as a UI panel the moment two hits landed close together; dice are what make it
// read as physics. The rolls are FACTORS on the CSS geometry, never pixel values: the base
// magnitudes (and their ≤640px step-down) stay in CSS where the media query can reach them,
// and the jitter range is bounded so the widest possible throw still clears a 320px screen
// (see index.css).
//
// TIMING lives here and is handed to CSS as variables, so the timer that ends the loot
// and the animation that flies it cannot disagree.
const LOOT_RISE_MS = 340;
const LOOT_FALL_MS = 440;
const lootDurationMs = LOOT_RISE_MS + LOOT_FALL_MS;

const roll = (min: number, max: number) => min + Math.random() * (max - min);

export default function Loot({
  id,
  rank,
  delayMs = 0,
  onDone,
}: {
  id: number; // monotonic: a new hit replaces the loot in the air
  rank: number;
  // How long after mount the throw starts — the sentence staggers its holes' feedback.
  delayMs?: number;
  onDone?: (id: number) => void;
}) {
  useEffect(() => {
    const t = setTimeout(() => onDone && onDone(id), delayMs + lootDurationMs);
    return () => clearTimeout(t);
  }, [id, delayMs, onDone]);

  // The hit's roll, once per hit (the component is re-keyed per hit, so a new hit is a new
  // throw): its side, then its drift, apex, drop and tilt factors.
  const flight = useMemo(
    () => ({
      left: Math.random() < 0.5,
      dice: {
        '--loot-jx': roll(0.85, 1.15).toFixed(3),
        '--loot-jy': roll(0.95, 1.2).toFixed(3),
        '--loot-jd': roll(0.85, 1.15).toFixed(3),
        '--loot-jt': roll(0.7, 1.3).toFixed(3),
      } as CSSProperties,
    }),
    [id],
  );

  return (
    <span
      className={`loot loot-exp ${flight.left ? 'loot-to-left' : 'loot-to-right'}`}
      style={
        {
          ...flight.dice,
          color: rankHeatColor(rank),
          '--loot-rise': `${LOOT_RISE_MS}ms`,
          '--loot-fall': `${LOOT_FALL_MS}ms`,
          '--loot-delay': `${delayMs}ms`,
        } as CSSProperties
      }
    >
      <span className="loot-lift">{String(rank)}</span>
    </span>
  );
}
