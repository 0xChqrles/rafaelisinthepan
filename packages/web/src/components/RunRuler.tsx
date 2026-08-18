import type { CSSProperties } from 'react';

// A run's RULER (bucketed squares -> per-try cells 2026-07-24 -> gradient filament ->
// a FLAT RULE, user-decided 2026-08-18): one solid sharp bar, one tick at each try
// that dropped a secret with the hole's sentence index (1..3) under it. A guess that
// drops several secrets stacks its indices under ONE tick. The per-try heat colours
// left with the gradient — the run's colour story lives in the share card's cells and
// the emoji row now; on screen the ticks ARE the information.
//
// The two reveal beats keep their old timeline: `shown` wipes the bar in over
// `--sweep-ms` = n × the same stagger the old per-cell delays used (so the owning
// screen's choreography in resultAnimation needed no change, and rulerStagger's
// reduced-motion zero still collapses the sweep), and `colorized` fades the ticks in
// on their column delays.
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
          '--sweep-ms': `${Math.round(n * stagger)}ms`,
        } as CSSProperties
      }
    >
      <div className="run-bar">
        <span className="run-track" aria-hidden="true" />
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
