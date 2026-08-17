import type { CSSProperties } from 'react';
import { progressHeatColor } from '@whippin/shared';

// A run's RULER (replacing the bucketed squares, decided 2026-07-24; rendered as ONE
// CONTINUOUS GRADIENT since 2026-08-18): still the raw trajectory, no bucketing — one
// gradient stop per counted try at that try's progressHeatColor, drawn as a smooth
// rounded bar with its own bloom — with a white pin at each try that dropped a secret
// and the hole's sentence index (1..3) under it. A guess that drops several secrets
// stacks its indices under ONE pin.
//
// The stops use the shared weird→calm ramp: a try's reconstruction % reads STRAIGHT from
// the red MISS terminus through amber, coral and orchid to the cobalt solve terminus. Rank
// exponents use the same stops through their own fixed logarithmic mapping.
//
// The two reveal beats keep their old timeline: `shown` wipes the neutral track in,
// `colorized` chases it with the gradient. Both wipes run `--sweep-ms` = n × the same
// stagger the per-cell delays used, so the owning screen's choreography (resultAnimation)
// needed no change, and rulerStagger's reduced-motion zero still collapses the sweep.
export default function RunRuler({
  trajectory,
  solvedAt,
  stagger,
  shown,
  colorized,
}: {
  trajectory: number[];
  solvedAt: (number | null)[];
  stagger: number;
  shown: boolean;
  colorized: boolean;
}) {
  const n = Math.max(trajectory.length, 1);
  // One stop per try, placed at its slice's CENTER, so the gradient interpolates between
  // tries instead of smearing the first and last into the bar's ends.
  const gradient =
    trajectory.length <= 1
      ? `linear-gradient(90deg, ${progressHeatColor(trajectory[0] ?? 0)}, ${progressHeatColor(
          trajectory[0] ?? 0,
        )})`
      : `linear-gradient(90deg, ${trajectory
          .map((pct, i) => `${progressHeatColor(pct)} ${(((i + 0.5) / n) * 100).toFixed(2)}%`)
          .join(', ')})`;
  // Group solve moments by try: one pin per solving guess, its hole indices stacked.
  const ticks: { at: number; holes: number[] }[] = [];
  solvedAt.forEach((at, i) => {
    if (at === null) return;
    const tick = ticks.find((x) => x.at === at);
    if (tick) tick.holes.push(i + 1);
    else ticks.push({ at, holes: [i + 1] });
  });
  ticks.sort((a, b) => a.at - b.at);
  return (
    <div
      className={`run-ruler${shown ? ' shown' : ''}${colorized ? ' colorized' : ''}`}
      style={
        {
          '--n': n,
          '--run-gradient': gradient,
          '--sweep-ms': `${Math.round(n * stagger)}ms`,
        } as CSSProperties
      }
    >
      <div className="run-bar">
        <span className="run-bloom" aria-hidden="true" />
        <span className="run-track" aria-hidden="true" />
        <span className="run-fill" aria-hidden="true" />
        {ticks.map((tick) => (
          <span
            key={tick.at}
            className="run-tick"
            style={
              {
                '--at': tick.at,
                '--tick-delay': `${Math.round((tick.at - 1) * stagger)}ms`,
              } as CSSProperties & Record<'--at' | '--tick-delay', string | number>
            }
          >
            <span className="run-tick-nums">
              {tick.holes.map((h) => (
                <span key={h}>{h}</span>
              ))}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

// The colorize-wave pacing: per-try column delays, capped so the whole sweep never
// exceeds the max span. Under
// reduced motion the stagger is ZERO — the global CSS rule collapses DURATIONS but not
// transition-DELAYS, so without this the sweep would still crawl across the bar for over
// a second for a viewer who asked for no motion.
const RULER_STAGGER_MS = 55;
const RULER_MAX_SPAN_MS = 1400;
export function rulerStagger(maxN: number, reduceMotion = false): number {
  if (reduceMotion || maxN <= 1) return 0;
  return Math.min(RULER_STAGGER_MS, RULER_MAX_SPAN_MS / (maxN - 1));
}
