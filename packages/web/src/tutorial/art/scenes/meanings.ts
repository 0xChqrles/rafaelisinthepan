import { CORAL, COBALT, CYAN, DEEP, ORCHID, RAIL, RED, WHITE, clamp01, put, th } from './kit';
import type { SceneMaker } from './kit';

// ------------------------------------------------------------------------ MANY MEANINGS
// One word, two senses, drawn as two wells of meaning: the sky (cool, broad, airy) up on the
// left, the theft (warm, tight, dense) down on the right. Their level lines slide slowly in
// toward each centre. Beyond the ridge between the two, a line holds both senses in one loop
// (the one vector, in the rail's grey); each time that loop shrinks past the ridge it pinches
// and splits in two — right where the word sits, a held chip that belongs to neither side.
// The two wells swell in turn, and the ridge, and the word on it, give way a little to each:
// it never settles.
const meanings: SceneMaker = (cols, rows, stage) => {
  const inks = [WHITE, CYAN, COBALT, DEEP, CORAL, RED, ORCHID, RAIL];
  const [I_WHITE, I_CYAN, I_COBALT, I_DEEP, I_CORAL, I_RED, I_ORCHID, I_RAIL] = [1, 2, 3, 4, 5, 6, 7, 8];
  const W = stage.w;
  const H = stage.h;
  const S = Math.min(W, H * 1.9);
  const U = Math.max(1, Math.round(S / 110));
  const dx = Math.min(W * 0.25, S * 0.3);
  const dy = S * 0.07;
  // A well's level lines are not concentric: each one's centre slides with its size (k) —
  // the sky's inner lines ride HIGH (it rises), the theft's sit LOW (it sinks, heavy).
  const A = { x: W / 2 - dx, y: H / 2 - dy, sx: S * 0.115, sy: S * 0.145, k: 0.32 }; // the sky
  // the theft — kept a few cells wide on a small card, so its close lines never merge
  const B = {
    x: W / 2 + dx,
    y: H / 2 + dy,
    sx: Math.max(S * 0.1, Math.min(10, S * 0.13)),
    sy: Math.max(S * 0.07, Math.min(7, S * 0.092)),
    k: -0.2,
  };
  // A well at (x, y): the squared radius, in the well's own units, of its line through there
  // (solved for a line centred at (0, k·ρ)).
  const rho2 = (c: typeof A, x: number, y: number) => {
    const u = (x - c.x) / c.sx;
    const w = (y - c.y) / c.sy;
    const rho = (-w * c.k + Math.sqrt(w * w * c.k * c.k + (1 - c.k * c.k) * (u * u + w * w))) / (1 - c.k * c.k);
    return rho * rho;
  };

  // The two wells, once, as log-depths: a cell's depth in each is −ρ²/2.
  const n = cols * rows;
  const la = new Float32Array(n);
  const lb = new Float32Array(n);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      la[y * cols + x] = -rho2(A, x, y) / 2;
      lb[y * cols + x] = -rho2(B, x, y) / 2;
    }
  }
  // The way from one centre to the other, sampled once: the ridge is its lowest point.
  const PATH = 160;
  const path = Array.from({ length: PATH + 1 }, (_, k) => {
    const f = k / PATH;
    const x = A.x + (B.x - A.x) * f;
    const y = A.y + (B.y - A.y) * f;
    return { x, y, la: -rho2(A, x, y) / 2, lb: -rho2(B, x, y) / 2 };
  });

  // Each well's lines are shaded by height, in the dither: the sky's evaporate toward the top
  // (air, rising), the theft's hold whole at the bottom (weight).
  const skyLift = Float32Array.from(
    { length: rows },
    (_, y) => 1 - 0.75 * clamp01((A.y + A.sy * 0.4 - y) / (A.sy * 1.9)),
  );
  const theftLift = Float32Array.from({ length: rows }, (_, y) => 1 - 0.4 * clamp01((B.y - y) / (B.sy * 1.6)));

  const STEP = Math.max(0.55, 4.6 / B.sy); // level-line spacing, in D: never under ~4 cells
  const PERIOD = 7; // seconds for a line to slide in by one spacing
  const SWELL = 17; // seconds for the two wells to trade places
  const D = new Float32Array(n);
  const q = new Int16Array(n);
  const chipW = U * Math.min(13, Math.max(9, Math.round(S / 6)));
  const chipH = 5 * U;

  return {
    inks,
    draw(r, t) {
      // Each well's reach: one swells as the other ebbs (a depth scales as 1/size²).
      const sw = 0.09 * Math.sin((t * 2 * Math.PI) / SWELL);
      const ka = 1 / (1 + sw) ** 2;
      const kb = 1 / (1 - sw) ** 2;
      const phase = (t / PERIOD) % 1;
      for (let i = 0; i < n; i += 1) {
        const a = Math.exp(la[i] * ka);
        const b = Math.exp(lb[i] * kb);
        const v = a + b;
        const d = v >= 1 ? 0 : Math.sqrt(-2 * Math.log(v));
        D[i] = a >= b ? d : -1 - d; // the sign keeps which well holds the cell
        q[i] = Math.floor(d / STEP + phase);
      }
      // The word, on the ridge.
      let at = path[0];
      let low = Infinity;
      for (const p of path) {
        const v = Math.exp(p.la * ka) + Math.exp(p.lb * kb);
        if (v < low) {
          low = v;
          at = p;
        }
      }
      const shared = Math.sqrt(-2 * Math.log(low)) + 0.08; // beyond: loops round both senses
      for (let y = 0; y < rows - 1; y += 1) {
        for (let x = 0; x < cols - 1; x += 1) {
          const i = y * cols + x;
          if (q[i] === q[i + 1] && q[i] === q[i + cols]) continue;
          const sky = D[i] >= 0;
          const d = sky ? D[i] : -1 - D[i];
          if (d < 0.3) continue; // a line that reached its centre is gone
          if (d > shared) {
            // The loop round both senses: whole, and only the first — the next one dithers
            // in as it comes.
            if (1 - clamp01((d - shared - STEP * 0.6) / (STEP * 0.4)) <= th(x, y)) continue;
            r.ink[i] = I_RAIL;
          } else if (sky) {
            // The sky's lines thin into dots toward the top and the edge (air, rising); a
            // line dims as it sinks into the centre.
            if (skyLift[y] * (1 - clamp01((d - 1.1) / 2.0)) <= th(x, y)) continue;
            r.ink[i] = d < 0.45 ? I_DEEP : d < 0.6 ? I_COBALT : d < 1.05 ? I_CYAN : d < 1.7 ? I_COBALT : I_DEEP;
          } else {
            // The theft's stay close together (dense) and whole at the bottom (heavy).
            if (theftLift[y] <= th(x, y)) continue;
            r.ink[i] = d < 0.5 ? I_RED : d < 1.05 ? I_CORAL : I_RED;
          }
        }
      }
      const x0 = Math.round(at.x - chipW / 2);
      const y0 = Math.round(at.y - chipH / 2);
      for (let y = y0 - U; y < y0 + chipH + U; y += 1) {
        for (let x = x0 - U; x < x0 + chipW + U * 5; x += 1) put(r, x, y, 0);
      }
      for (let y = y0; y < y0 + chipH; y += 1) {
        for (let x = x0; x < x0 + chipW; x += 1) put(r, x, y, I_WHITE);
      }
      // Its exponent: the one rank it gets, halfway along the ramp between the two.
      for (let y = 0; y < 2 * U; y += 1) {
        for (let x = 0; x < 3 * U; x += 1) put(r, x0 + chipW + U + x, y0 - U + y, I_ORCHID);
      }
    },
  };
};

export default meanings;
