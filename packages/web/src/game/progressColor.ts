const PROGRESS_STOPS = [
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

function mix(a: number, b: number, t: number) {
  return Math.round(a + (b - a) * t);
}

export function progressColor(progress: number) {
  const value = Math.max(PROGRESS_STOPS[0].v, Math.min(PROGRESS_STOPS[PROGRESS_STOPS.length - 1].v, progress));

  let from = PROGRESS_STOPS[0];
  let to = PROGRESS_STOPS[PROGRESS_STOPS.length - 1];
  for (let i = 1; i < PROGRESS_STOPS.length; i += 1) {
    if (value <= PROGRESS_STOPS[i].v) {
      from = PROGRESS_STOPS[i - 1];
      to = PROGRESS_STOPS[i];
      break;
    }
  }

  const localT = from.v === to.v ? 0 : (value - from.v) / (to.v - from.v);
  const [r1, g1, b1] = from.color;
  const [r2, g2, b2] = to.color;
  return `rgb(${mix(r1, r2, localT)}, ${mix(g1, g2, localT)}, ${mix(b1, b2, localT)})`;
}
