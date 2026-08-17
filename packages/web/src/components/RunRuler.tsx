import type { CSSProperties } from 'react';
import { progressHeatColor } from '@whippin/shared';

// A run's RULER (replacing the bucketed squares, decided 2026-07-24): one fixed bar,
// one cell per counted try, no bucketing — with a white tick at each try that dropped a
// secret and the hole's sentence index (1..3) under it. A guess that drops several secrets
// stacks its indices under ONE tick.
//
// The cells are coloured on the HEAT ramp since 2026-08-16 (user-decided, retiring the
// progress palette; the ramp itself is the iron bow since 2026-08-17): a try's
// reconstruction % is read STRAIGHT as heat, so the bar runs the kept iron window's whole
// length — cold violet-magenta at the start, through crimson and orange, to the hot yellow
// a rank-0 exponent wears on the solving try — the same ramp every rank in the round was
// coloured on.
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
  // Group solve moments by try: one tick per solving guess, its hole indices stacked.
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
      style={{ '--n': n } as CSSProperties}
    >
      <div className="run-bar">
        {trajectory.map((pct, i) => (
          <span
            // eslint-disable-next-line react/no-array-index-key
            key={i}
            className="run-cell"
            style={
              {
                '--cell-color': progressHeatColor(pct),
                '--show-delay': `${Math.round(i * stagger)}ms`,
                '--color-delay': `${Math.round(i * stagger)}ms`,
              } as CSSProperties &
                Record<'--cell-color' | '--show-delay' | '--color-delay', string>
            }
          />
        ))}
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
