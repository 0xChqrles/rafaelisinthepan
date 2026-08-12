import { useEffect, useMemo } from 'react';
import type { CSSProperties } from 'react';
import type { Rarity } from '../game/wordGame';
import { HIT_HEAT_CAP, rankHeatColor } from './Hole';

// The LOOT a claim knocks out of the day's word (decided 2026-08-10): the guess's rank
// exponent and its rarity grade pop off the struck word like drops off a hit enemy — up
// and apart on the impact, a hang at the top of the throw, then the fall — so the two
// numbers the bare run screen stopped stating (the distance, and the grade's NAME) are
// said for exactly the moment they are news, and are gone before the next guess needs
// the screen. The strike stays what it was; this is what the hit shakes loose.
//
// TWO pieces, one event: the exponent, written the one way the app writes ranks and in
// the heat colour every other exponent wears (the shared `rankHeatColor`), flies up one
// way; the grade's name, in its grade colour, up the other, a beat apart — the stagger
// is what makes them read as things tumbling out rather than one object splitting in two.
//
// THE THROW IS ROLLED PER HIT (decided 2026-08-10): which side each piece takes, which of
// the two launches first, and a small jitter on every piece's distance, height, drop and
// tilt. Loot that flew the identical arc on every kill read as a UI panel the moment two
// claims landed close together; dice are what make it read as physics. The rolls are
// FACTORS on the CSS geometry, never pixel values: the base magnitudes (and their ≤640px
// step-down) stay in CSS where the media query can reach them, and the jitter range is
// bounded so the widest possible throw still clears a 320px screen (see index.css).
//
// TIMING lives here and is handed to CSS as variables, so the timer that ends the loot
// and the animation that flies it cannot disagree.
const LOOT_RISE_MS = 340;
const LOOT_FALL_MS = 440;
const LOOT_STAGGER_MS = 60;
export const lootDurationMs = LOOT_STAGGER_MS + LOOT_RISE_MS + LOOT_FALL_MS;

const roll = (min: number, max: number) => min + Math.random() * (max - min);

// One piece's dice: drift, apex, drop and tilt factors. The apex's floor is 0.95, not the
// others' 0.85 — the grade's lowest arc already skims the word's cap height, so its jitter
// biases UP where the rest spread both ways.
const jitter = () =>
  ({
    '--loot-jx': roll(0.85, 1.15).toFixed(3),
    '--loot-jy': roll(0.95, 1.2).toFixed(3),
    '--loot-jd': roll(0.85, 1.15).toFixed(3),
    '--loot-jt': roll(0.7, 1.3).toFixed(3),
  }) as CSSProperties;

export default function WordLoot({
  id,
  rank,
  grade,
  color,
  onDone,
}: {
  id: number; // monotonic, like the strike's: a new claim replaces the loot in the air
  rank: number;
  grade: Rarity;
  color: string; // the grade's colour, already resolved by the screen
  onDone?: (id: number) => void;
}) {
  useEffect(() => {
    const t = setTimeout(() => onDone && onDone(id), lootDurationMs);
    return () => clearTimeout(t);
  }, [id, onDone]);

  // The hit's roll, once per claim (the component is re-keyed per hit, so a new claim is
  // a new throw). The two pieces always take OPPOSITE sides — that, with the edge
  // anchoring, is what keeps them collision-free whichever way the dice land.
  const flight = useMemo(() => {
    const expLeft = Math.random() < 0.5;
    const expFirst = Math.random() < 0.5;
    return { expLeft, expFirst, exp: jitter(), grade: jitter() };
  }, [id]);

  const pieces = [
    {
      key: 'exp',
      css: `word-loot-exp ${flight.expLeft ? 'word-loot-to-left' : 'word-loot-to-right'}`,
      text: `-${rank}`,
      color: rankHeatColor(rank, HIT_HEAT_CAP),
      delay: flight.expFirst ? 0 : LOOT_STAGGER_MS,
      dice: flight.exp,
    },
    {
      key: 'grade',
      css: `word-loot-grade ${flight.expLeft ? 'word-loot-to-right' : 'word-loot-to-left'}`,
      text: grade,
      color,
      delay: flight.expFirst ? LOOT_STAGGER_MS : 0,
      dice: flight.grade,
    },
  ];

  return (
    <>
      {pieces.map((piece) => (
        <span
          key={piece.key}
          className={`word-loot ${piece.css}`}
          style={
            {
              ...piece.dice,
              color: piece.color,
              '--loot-rise': `${LOOT_RISE_MS}ms`,
              '--loot-fall': `${LOOT_FALL_MS}ms`,
              '--loot-delay': `${piece.delay}ms`,
            } as CSSProperties
          }
        >
          <span className="word-loot-lift">{piece.text}</span>
        </span>
      ))}
    </>
  );
}
