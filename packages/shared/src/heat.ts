// The "heatmap" gradient: cold (crimson) -> hot (cyan). Colors the rank exponents +
// floating hits (web), the solved heat grid, and the share card (backend-rendered) —
// cross-cutting because the card must match the on-screen grid exactly. The progress
// bar and the selector badge use the OTHER ramp (progressColor.ts): a single ramp was
// tried and reverted — heat reads better on the exponents/squares (decided 2026-07-05).
// heat in [0,1]: 0 = cold, 1 = hot (near the goal / solved).
import { rampColor, type RampStop } from './ramp';

const HEAT_STOPS: RampStop[] = [
  { v: 0, color: [255, 28, 84] }, // cold: electric crimson
  { v: 0.3, color: [255, 138, 0] }, // vivid orange
  { v: 0.58, color: [200, 52, 255] }, // electric violet
  { v: 1, color: [0, 204, 255] }, // hot: electric cyan
];

// rgb() color interpolated on the heatmap for a given heat value.
export function heatColor(heat: number) {
  return rampColor(HEAT_STOPS, heat);
}
