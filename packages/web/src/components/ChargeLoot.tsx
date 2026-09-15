import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { CHARGE_TABLE } from '../game/charge';

// THE CHARGE a near guess knocks out of a hole (#301): sparks that pop off the struck word
// and fall into the meter drawn along the chip's bottom edge, landing exactly as the meter
// advances — so the fill reads as what the hit shook loose, not as a bar that moved on its
// own. Nothing parks: no `+7.5` ever sits on screen; the AMOUNT is said by how much flies.
//
// HOW MUCH FLIES is the charge table's own band (`sparkCount`): a top-three guess throws
// the most, the outermost band the fewest — the ladder the hit pays by, told in sparks.
// TWO PER BAND, never fewer than three (user-decided 2026-09-15, "a bit shy for now"): the
// first cut threw one per band and a low band's lone spark read as a stray pixel.
//
// TIMING is the hit's: the sparks launch a beat after the cut lands (`LOOT_LAUNCH_MS` past
// the hit's start delay) and land on the hole's release moment — `landAtMs`, the floating
// hit's fade delay, when the round releases the guess into the board and the meter fills.
// Both are handed to CSS as variables, so the flight and the fill cannot drift apart. The
// throw is rolled per hit (side, height, a little scatter), factors on em geometry the CSS
// holds, so a run of similar guesses never stamps one identical arc.
const LOOT_LAUNCH_MS = 60;
const FLIGHT_MIN_MS = 160;

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
  startDelayMs,
  landAtMs,
}: {
  id: number; // the hit's id: a new hit is a new throw
  charge: number; // what the hit added to the meter
  startDelayMs: number; // the hit's own start (the sentence's stagger)
  landAtMs: number; // when the meter advances — the hit's fade delay
}) {
  const launch = startDelayMs + LOOT_LAUNCH_MS;
  const flight = Math.max(FLIGHT_MIN_MS, landAtMs - launch);
  // The dice, once per hit (keyed by the hit, so a re-render cannot re-throw mid-flight).
  const sparks = useMemo(
    () =>
      Array.from({ length: sparkCount(charge) }, () => ({
        x: roll(-1, 1).toFixed(3),
        h: roll(0.6, 1.4).toFixed(3),
        // Size and brightness vary too: a shower of one-sized, one-toned squares reads
        // as a pattern, not as sparks.
        s: roll(0.8, 1.5).toFixed(3),
        l: Math.round(roll(0, 55)),
        delay: Math.round(roll(0, 90)),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id],
  );

  return (
    <>
      {sparks.map((spark, i) => (
        <span
          key={i}
          className="charge-spark"
          aria-hidden="true"
          style={
            {
              '--spark-x': spark.x,
              '--spark-h': spark.h,
              '--spark-s': spark.s,
              '--spark-l': `${spark.l}%`,
              '--spark-delay': `${launch + spark.delay}ms`,
              '--spark-ms': `${Math.max(FLIGHT_MIN_MS, flight - spark.delay)}ms`,
            } as CSSProperties
          }
        />
      ))}
    </>
  );
}
