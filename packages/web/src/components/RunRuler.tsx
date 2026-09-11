import type { CSSProperties } from 'react';
import { progressHeatColor } from '@whippin/shared';

// A run's RULER (replacing the bucketed squares, decided 2026-07-24): one fixed bar,
// one cell per counted try, no bucketing — with a white tick at each try that dropped a
// secret and the hole's sentence index (1..3) under it. A guess that drops several secrets
// stacks its indices under ONE tick.
//
// The cells use the shared weird→calm ramp: a try's reconstruction % reads STRAIGHT from
// the red MISS terminus through amber, coral and orchid to the cobalt solve terminus. Rank
// exponents use the same stops through their own fixed logarithmic mapping.
export default function RunRuler({
  trajectory,
  solvedAt,
  filled,
}: {
  trajectory: number[];
  solvedAt: (number | null)[];
  // How many tries are COLOURED IN — the tally's own count (user-decided 2026-09-11), so
  // the bar fills try by try as the number climbs: every cell stands from the start, the
  // ones past the count without their colour, and a tick stands once its try is reached.
  filled: number;
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
    <div className="run-ruler" style={{ '--n': n } as CSSProperties}>
      <div className="run-bar">
        {trajectory.map((pct, i) => (
          <span
            // eslint-disable-next-line react/no-array-index-key
            key={i}
            className={`run-cell${i < filled ? ' on' : ''}`}
            style={
              { '--cell-color': progressHeatColor(pct) } as CSSProperties &
                Record<'--cell-color', string>
            }
          />
        ))}
        {ticks.map((tick) => (
          <span
            key={tick.at}
            className={`run-tick${tick.at <= filled ? ' on' : ''}`}
            style={{ '--at': tick.at } as CSSProperties & Record<'--at', number>}
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
