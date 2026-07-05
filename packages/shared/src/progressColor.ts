// The progress-% ramp: colors the top progress bar and the language selector's %
// badge. The rank exponents, the solved heat grid, and the share card use heat.ts
// instead — a single ramp was tried and reverted (decided 2026-07-05). Both ramps
// share the one interpolator in ramp.ts.
// `progress` in [0,100] (clamped to the stops).
import { rampColor, type RampStop } from './ramp';

const PROGRESS_STOPS: RampStop[] = [
  { v: 15, color: [35, 132, 242] }, // blue
  { v: 30, color: [42, 210, 235] }, // cyan
  { v: 40, color: [35, 220, 145] }, // green
  { v: 50, color: [244, 194, 31] }, // gold
  { v: 60, color: [238, 103, 78] }, // coral
  { v: 70, color: [239, 79, 151] }, // pink
  { v: 80, color: [219, 36, 200] }, // magenta
  { v: 90, color: [136, 60, 235] }, // violet
  { v: 100, color: [70, 66, 232] }, // indigo
];

// rgb() color interpolated on the ramp for a progress value (%).
export function progressColor(progress: number) {
  return rampColor(PROGRESS_STOPS, progress);
}
