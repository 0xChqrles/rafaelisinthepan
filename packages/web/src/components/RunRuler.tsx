import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { progressHeatColor, runEdges } from '@whippin/shared';

// A run's RULER (replacing the bucketed squares, decided 2026-07-24): one fixed bar,
// one cell per counted try, no bucketing — with a white tick at each try that dropped a
// secret and the hole's sentence index (1..3) under it. A guess that drops several secrets
// sets their indices side by side under ONE tick.
//
// The cells use the shared weird→calm ramp: a try's reconstruction % reads STRAIGHT from
// the red MISS terminus through amber, coral and orchid to the cobalt solve terminus. Rank
// exponents use the same stops through their own fixed logarithmic mapping.
//
// WHOLE PIXELS, the share card's own: the bar's measured width is split at the shared
// `runEdges` boundaries (cardSvg.ts draws its bar on the same ones), so a long run's narrow
// cells stay hard-edged cells instead of blending at their seams, and a tick stands on the
// edge after its try exactly where the card puts it. The index lane under the bar is held on
// every run, ticks or none, so the ruler is one height whatever the round.
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
  // Group solve moments by try: one tick per solving guess, its hole indices together.
  const ticks: { at: number; holes: number[] }[] = [];
  solvedAt.forEach((at, i) => {
    if (at === null) return;
    const tick = ticks.find((x) => x.at === at);
    if (tick) tick.holes.push(i + 1);
    else ticks.push({ at, holes: [i + 1] });
  });
  ticks.sort((a, b) => a.at - b.at);

  // The cell edges in whole CSS px; null until the bar is measured (the cells then share the
  // bar evenly).
  const barRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<number[] | null>(null);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return undefined;
    const measure = () => {
      const w = Math.round(bar.getBoundingClientRect().width);
      if (!w) return;
      const next = runEdges(n, w);
      setEdges((prev) =>
        prev && prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next,
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [n]);

  return (
    <div className="run-ruler" style={{ '--n': n } as CSSProperties}>
      <div ref={barRef} className={`run-bar${edges ? ' snapped' : ''}`}>
        {trajectory.map((pct, i) => (
          <span
            key={i}
            className={`run-cell${i < filled ? ' on' : ''}`}
            style={
              {
                '--cell-color': progressHeatColor(pct),
                ...(edges ? { width: `${edges[i + 1] - edges[i]}px` } : null),
              } as CSSProperties
            }
          />
        ))}
        {ticks.map((tick) => (
          <span
            key={tick.at}
            // A tick near an END of the bar holds its indices inside it (a row of several
            // under one tick would otherwise hang past the column's edge).
            className={`run-tick${tick.at <= filled ? ' on' : ''}${tick.at / n > 0.9 ? ' end' : tick.at / n < 0.1 ? ' start' : ''}`}
            style={
              {
                '--at': tick.at,
                ...(edges ? { left: `${edges[Math.min(tick.at, n)]}px` } : null),
              } as CSSProperties
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
