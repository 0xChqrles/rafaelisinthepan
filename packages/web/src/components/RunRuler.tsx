import type { CSSProperties } from 'react';
import { progressColor } from '@whippin/shared';

// One entrant's replayed run for the ruler: the per-try trajectory plus the solve
// moments (per distinct secret in sentence order, the 1-based solving try or null).
export interface RunReplay {
  trajectory: number[];
  solvedAt: (number | null)[];
}

// A run's RULER (replacing the bucketed squares, decided 2026-07-24): one fixed bar,
// one cell per counted try colored on the PROGRESS ramp (progressColor — each try's
// cell IS the progress bar's color at that reconstruction %), no bucketing — with
// a white tick at each try that dropped a secret and the hole's sentence index (1..3)
// under it. A guess that drops several secrets stacks its indices under ONE tick. On
// the leaderboard every bar shares one scale (width ∝ tries / longest run) so solve
// moments align down the table; the standalone (opponent-less) ruler is full width.
export default function RunRuler({
  trajectory,
  solvedAt,
  maxN,
  stagger,
  shown,
  colorized,
  solo,
}: {
  trajectory: number[];
  solvedAt: (number | null)[];
  maxN: number;
  stagger: number;
  shown: boolean;
  colorized: boolean;
  solo?: boolean;
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
      className={`run-ruler${solo ? ' solo' : ''}${shown ? ' shown' : ''}${
        colorized ? ' colorized' : ''
      }`}
      style={{ '--n': n, '--max-n': maxN } as CSSProperties}
    >
      <div className="run-bar">
        {trajectory.map((pct, i) => (
          <span
            // eslint-disable-next-line react/no-array-index-key
            key={i}
            className="run-cell"
            style={
              {
                '--cell-color': progressColor(pct),
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

// The shared colorize-wave pacing (used by the solved tray and the leaderboard dialog):
// per-try column delays, capped so the whole sweep never exceeds the max span.
export const RULER_STAGGER_MS = 55;
export const RULER_MAX_SPAN_MS = 1400;
export function rulerStagger(maxN: number): number {
  return maxN > 1 ? Math.min(RULER_STAGGER_MS, RULER_MAX_SPAN_MS / (maxN - 1)) : 0;
}
