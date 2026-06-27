// Shared "heatmap" gradient: cold (red) -> hot (blue).
// heat in [0,1]: 0 = cold, 1 = hot (near the goal / solved).
const HEAT_STOPS = [
  { t: 0, color: [255, 28, 84] }, // cold: electric crimson
  { t: 0.3, color: [255, 138, 0] }, // vivid orange
  { t: 0.58, color: [200, 52, 255] }, // electric violet
  { t: 1, color: [0, 204, 255] }, // hot: electric cyan
];

function mix(a: number, b: number, t: number) {
  return Math.round(a + (b - a) * t);
}

// rgb() color interpolated on the heatmap for a given heat value.
export function heatColor(heat: number) {
  const h = Math.max(0, Math.min(1, heat));

  let from = HEAT_STOPS[0];
  let to = HEAT_STOPS[HEAT_STOPS.length - 1];
  for (let i = 1; i < HEAT_STOPS.length; i += 1) {
    if (h <= HEAT_STOPS[i].t) {
      from = HEAT_STOPS[i - 1];
      to = HEAT_STOPS[i];
      break;
    }
  }

  const localT = from.t === to.t ? 0 : (h - from.t) / (to.t - from.t);
  const [r1, g1, b1] = from.color;
  const [r2, g2, b2] = to.color;
  return `rgb(${mix(r1, r2, localT)}, ${mix(g1, g2, localT)}, ${mix(b1, b2, localT)})`;
}
