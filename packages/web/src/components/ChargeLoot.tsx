import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { CHARGE_TABLE } from '../game/charge';

// THE CHARGE a near guess knocks out of a hole (#301): sparks the hit throws out of the
// word in every direction — they scatter around the hole, hang a beat, then are GATHERED
// onto the bar at the fill's new tip, and the fill travels as they land (user-decided
// 2026-09-15) — so the fill reads as what the hit shook loose, not as a bar that moved on
// its own. Nothing parks: no `+7.5` ever sits on screen; the AMOUNT is said by how much flies.
//
// HOW MUCH FLIES is the charge table's own band (`sparkCount`): a top-three guess throws
// the most, the outermost band the fewest — the ladder the hit pays by, told in sparks.
// TWO PER BAND, never fewer than three (user-decided 2026-09-15, "a bit shy for now"): the
// first cut threw one per band and a low band's lone spark read as a stray pixel.
//
// TIMING is the hit's: the sparks launch a beat after the cut lands (`LOOT_LAUNCH_MS` past
// the hit's start delay) and ALL land together `SPARK_FLIGHT_MS` later (a spark's own start
// jitter is taken off its flight, never added to its landing). The round releases the guess
// into the board earlier than that, on the floating hit's beat, so the METER'S FILL WAITS —
// Hole reads `sparkLandMs` and delays the fill's transition to the landing, and the flight
// and the fill cannot drift apart. The throw is rolled per hit (direction, distance, size,
// brightness), factors on em geometry the CSS holds, so a run of similar guesses never
// stamps one identical burst.
const LOOT_LAUNCH_MS = 60;
export const SPARK_FLIGHT_MS = 700;
const SCATTER_MIN_EM = 1.1;
const SCATTER_MAX_EM = 2.4;

// When a hit's sparks have gathered on the bar, from the hit's own start.
export function sparkLandMs(startDelayMs: number): number {
  return startDelayMs + LOOT_LAUNCH_MS + SPARK_FLIGHT_MS;
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
}: {
  id: number; // the hit's id: a new hit is a new throw
  charge: number; // what the hit added to the meter
  fill: number; // the meter's reading once it lands, 0-100: where the sparks gather
  startDelayMs: number; // the hit's own start (the sentence's stagger)
}) {
  const launch = startDelayMs + LOOT_LAUNCH_MS;
  // The dice, once per hit (keyed by the hit, so a re-render cannot re-throw mid-flight):
  // every spark its own direction and distance around the hole, size and brightness — a
  // shower of one-sized, one-toned squares on one arc reads as a pattern, not as sparks.
  const sparks = useMemo(
    () =>
      Array.from({ length: sparkCount(charge) }, () => {
        const angle = roll(0, Math.PI * 2);
        const r = roll(SCATTER_MIN_EM, SCATTER_MAX_EM);
        return {
          dx: `${(Math.cos(angle) * r).toFixed(2)}em`,
          dy: `${(Math.sin(angle) * r * 0.8).toFixed(2)}em`,
          s: roll(0.8, 1.5).toFixed(3),
          l: Math.round(roll(0, 55)),
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
      {sparks.map((spark, i) => (
        <span
          key={i}
          className="charge-spark"
          aria-hidden="true"
          style={
            {
              '--spark-dx': spark.dx,
              '--spark-dy': spark.dy,
              '--spark-s': spark.s,
              '--spark-l': `${spark.l}%`,
              '--spark-lx': landX,
              '--spark-delay': `${launch + spark.delay}ms`,
              '--spark-ms': `${SPARK_FLIGHT_MS - spark.delay}ms`,
            } as CSSProperties
          }
        />
      ))}
    </>
  );
}
