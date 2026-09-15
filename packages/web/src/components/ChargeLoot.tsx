import { useEffect, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { CHARGE_TABLE } from '../game/charge';

// THE CHARGE a near guess knocks out of a hole (#301) is BLOOD (user-decided 2026-09-15):
// the hole is an enemy, the hit sends drops flying out of it on their own arcs, they splat
// where they land around and below the word, lie there for a pause, and are then pulled
// onto the bar at the fill's new tip — each dragging a trail — and the fill travels as they
// land. So the fill reads as what the hit shook loose, not as a bar that moved on its own.
// Nothing parks: no `+7.5` ever sits on screen; the AMOUNT is said by how much flies.
//
// HOW MUCH FLIES is the charge table's own band (`sparkCount`): a top-three guess throws
// the most, the outermost band the fewest — the ladder the hit pays by, told in sparks.
// TWO PER BAND, never fewer than three (user-decided 2026-09-15, "a bit shy for now"): the
// first cut threw one per band and a low band's lone spark read as a stray pixel.
//
// TIMING is the hit's: the drops launch a beat after the cut lands (`LOOT_LAUNCH_MS` past
// the hit's start delay) and ALL land on the bar together `SPARK_FLIGHT_MS` later (a
// drop's own start jitter is taken off its flight, never added to its landing); the trail
// copies run the same path `TRAIL_LAG_MS` apart and arrive last, which is when the hit is
// over (`onDone`). The round releases the guess into the board earlier than that, on the
// floating hit's beat, so the METER'S FILL WAITS — Hole reads `sparkLandMs` and delays the
// fill's transition to the landing, and the flight and the fill cannot drift apart. The
// throw is rolled per hit (direction, distance, height, size), factors on em geometry the
// CSS holds, so a run of similar guesses never stamps one identical splatter.
const LOOT_LAUNCH_MS = 60;
export const SPARK_FLIGHT_MS = 900;
const TRAIL_COPIES = 2;
const TRAIL_LAG_MS = 45;
// Where a drop lands around the hole: sideways either way, mostly BELOW the word (blood
// pools under what was hit), after flying up first.
const SCATTER_X_MIN_EM = 0.5;
const SCATTER_X_MAX_EM = 2.6;
const SCATTER_Y_MIN_EM = -0.3;
const SCATTER_Y_MAX_EM = 1.5;
const UP_MIN_EM = 0.4;
const UP_MAX_EM = 1.3;

// When a hit's drops have gathered on the bar, from the hit's own start.
export function sparkLandMs(startDelayMs: number): number {
  return startDelayMs + LOOT_LAUNCH_MS + SPARK_FLIGHT_MS;
}
// When the last trail copy has followed them in — the throw's whole lifetime.
export function chargeLootMs(startDelayMs: number): number {
  return sparkLandMs(startDelayMs) + TRAIL_COPIES * TRAIL_LAG_MS;
}

// Two sparks per table row the charge reaches, counted from the outermost band: the
// smallest pay throws three, a top-band pay the whole table's worth twice over.
const SPARKS_PER_BAND = 2;
const SPARKS_MIN = 3;
export function sparkCount(charge: number): number {
  if (charge <= 0) return 0;
  let n = 0;
  for (const [, pay] of CHARGE_TABLE) if (charge >= pay) n += SPARKS_PER_BAND;
  return Math.max(SPARKS_MIN, n);
}

const roll = (min: number, max: number) => min + Math.random() * (max - min);

export default function ChargeLoot({
  id,
  charge,
  fill,
  startDelayMs,
  onDone,
}: {
  id: number; // the hit's id: a new hit is a new throw
  charge: number; // what the hit added to the meter
  fill: number; // the meter's reading once it lands, 0-100: where the drops gather
  startDelayMs: number; // the hit's own start (the sentence's stagger)
  onDone?: (id: number) => void; // the throw is over: every drop and its trail is in
}) {
  const launch = startDelayMs + LOOT_LAUNCH_MS;
  useEffect(() => {
    const t = setTimeout(() => onDone && onDone(id), chargeLootMs(startDelayMs));
    return () => clearTimeout(t);
  }, [id, startDelayMs, onDone]);
  // The dice, once per hit (keyed by the hit, so a re-render cannot re-throw mid-flight):
  // every drop its own side, distance, height and size — one colour for all of them (a
  // shower of mixed tones read as sparks, and this is blood).
  const sparks = useMemo(
    () =>
      Array.from({ length: sparkCount(charge) }, () => {
        const side = Math.random() < 0.5 ? -1 : 1;
        return {
          dx: `${(side * roll(SCATTER_X_MIN_EM, SCATTER_X_MAX_EM)).toFixed(2)}em`,
          dy: `${roll(SCATTER_Y_MIN_EM, SCATTER_Y_MAX_EM).toFixed(2)}em`,
          up: `${roll(UP_MIN_EM, UP_MAX_EM).toFixed(2)}em`,
          s: roll(0.8, 1.5).toFixed(3),
          delay: Math.round(roll(0, 90)),
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id],
  );
  // The bar spans the chip (the word plus its 0.2em overhang a side); its tip after this
  // hit is where every spark ends up.
  const landX = `calc(-0.2em + ${(fill / 100).toFixed(4)} * (100% + 0.4em))`;

  return (
    <>
      {sparks.map((spark, i) =>
        // The drop, then its trail: the same path, each copy a lag later.
        Array.from({ length: 1 + TRAIL_COPIES }, (_, copy) => (
          <span
            key={`${i}-${copy}`}
            className={`charge-spark${copy ? ` trail trail-${copy}` : ''}`}
            aria-hidden="true"
            style={
              {
                '--spark-dx': spark.dx,
                '--spark-dy': spark.dy,
                '--spark-up': spark.up,
                '--spark-s': spark.s,
                '--spark-lx': landX,
                '--spark-delay': `${launch + spark.delay + copy * TRAIL_LAG_MS}ms`,
                '--spark-ms': `${SPARK_FLIGHT_MS - spark.delay}ms`,
              } as CSSProperties
            }
          />
        )),
      )}
    </>
  );
}
