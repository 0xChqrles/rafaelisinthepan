// Shared piecewise-linear color interpolation for the game's two ramps (heat.ts and
// progressColor.ts) — the stops differ, the math doesn't, so it lives once. `value` is
// clamped to the stops' range, then mixed between the two surrounding stops. Internal
// to @whippin/shared: consumers use the ramps, not this.
export interface RampStop {
  v: number;
  color: [number, number, number];
}

function mix(a: number, b: number, t: number) {
  return Math.round(a + (b - a) * t);
}

// rgb() color interpolated on `stops` (ascending by v) for `value`.
export function rampColor(stops: readonly RampStop[], value: number): string {
  const v = Math.max(stops[0].v, Math.min(stops[stops.length - 1].v, value));

  let from = stops[0];
  let to = stops[stops.length - 1];
  for (let i = 1; i < stops.length; i += 1) {
    if (v <= stops[i].v) {
      from = stops[i - 1];
      to = stops[i];
      break;
    }
  }

  const t = from.v === to.v ? 0 : (v - from.v) / (to.v - from.v);
  const [r1, g1, b1] = from.color;
  const [r2, g2, b2] = to.color;
  return `rgb(${mix(r1, r2, t)}, ${mix(g1, g2, t)}, ${mix(b1, b2, t)})`;
}
