import { AMBER, COBALT, CYAN, MUTED, ORCHID, RAIL, RED, WHITE, put, rnd } from './kit';
import type { Raster, SceneMaker } from './kit';

// ------------------------------------------------------------------------ THE DISTANCE
// A space of words, turning slowly around the secret. The secret sits at the centre in the
// full hole's foil; its nearest words ride the rings of their distance, one to a ring, each a
// held chip wearing its rank's heat (cobalt the nearest, red the farthest) and drawing its
// ring in that heat behind it. Past the last ring, the rest of the vocabulary: grey knots of
// words — other neighbourhoods — the near ones brighter and bigger, all turning together.
const distance: SceneMaker = (cols, rows, stage) => {
  const inks = [WHITE, MUTED, RAIL, COBALT, CYAN, ORCHID, AMBER, RED];
  const [I_WHITE, I_MUTED, I_RAIL, I_COBALT, I_CYAN, I_ORCHID, I_AMBER, I_RED] = [1, 2, 3, 4, 5, 6, 7, 8];
  // The heat of ranks 1 → 4: the ramp read from its calm end, one stop skipped (coral, too near
  // red and orchid to tell apart on a chip's shoulder).
  const HEAT = [I_COBALT, I_ORCHID, I_AMBER, I_RED];

  // The frame: on a card, the rings keep clear of the fade into the title (its band reaches
  // about 9 cells above the stage's edge) and may rise between the top row's two corners; a
  // sleeve is all stage.
  const card = stage.h < rows;
  const top = card ? 8 : 3;
  const bottom = stage.h - (card ? 9 : 3);
  const availH = Math.max(8, bottom - top);
  const unit = Math.max(1, Math.round(Math.min(cols, availH * 1.9) / 120));

  // The camera: looking down on the rings' plane, steeper when the stage is tall, the outer
  // ring spanning about half the width — or 80% of the height, whichever binds.
  const D = 5; // the eye's distance, in outer-ring radii
  const HX = cols * 0.27;
  const HY = availH * 0.4;
  const sinT = Math.min(0.6, Math.max(0.42, HY / HX));
  const cosT = Math.sqrt(1 - sinT * sinT);
  const s = Math.min(HX, HY / sinT);
  const up = (s * sinT * D) / (D + cosT);
  const down = (s * sinT * D) / (D - cosT);
  const cx = cols / 2;
  const cy = top + (availH - up - down) / 2 + up;

  type P = { sx: number; sy: number; zz: number; f: number };
  const project = (x: number, y: number, z: number, ca: number, sa: number): P => {
    const xr = x * ca - z * sa;
    const zr = x * sa + z * ca;
    const zz = zr * cosT - y * sinT;
    const f = D / (D + zz);
    return { sx: cx + xr * s * f, sy: cy - (y * cosT + zr * sinT) * s * f, zz, f };
  };

  // The nearest words: one per ring, their angles spread so no two ever ride together.
  const RADII = [0.34, 0.56, 0.78, 1.0];
  const ANGLES = [0.35, 2.75, 4.7, 1.3];
  const WIDTHS = [5, 4, 6, 5];
  const near = RADII.map((rad, k) => ({
    x: Math.cos(ANGLES[k]) * rad,
    z: Math.sin(ANGLES[k]) * rad,
    w: WIDTHS[k] * unit,
    ink: HEAT[k],
  }));
  // Each word's TRAIL: its ring drawn in its heat behind it, solid at the word and breaking
  // into shorter and shorter dashes along the arc — the same length of arc for every ring, so
  // the inner rings close almost into circles and the outer ones stay arcs. Fixed in the
  // space, so the pattern is laid once, here.
  const TRAIL = 1.3 * s; // in cells of arc
  const DASH = 3 * unit;
  const rings = RADII.map((rad, k) => {
    const pts: { x: number; z: number }[] = [];
    const arc = Math.min(TRAIL, rad * s * Math.PI * 1.9);
    for (let u = 0; u < arc; u += 0.5) {
      if (u % DASH >= DASH * (1 - u / TRAIL) ** 1.4) continue;
      const phi = ANGLES[k] - u / (rad * s);
      pts.push({ x: Math.cos(phi) * rad, z: Math.sin(phi) * rad });
    }
    return pts;
  });

  // The rest of the vocabulary, beyond the last ring: other neighbourhoods, each a knot of
  // words, and a few loners between them.
  type Word = { x: number; y: number; z: number };
  const words: Word[] = [];
  const gauss = (i: number, j: number) => {
    const u = Math.max(1e-6, rnd(i, j, 11));
    const v = rnd(i, j, 12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const CLUSTERS = 11;
  // How high the vocabulary reaches above and below the rings' plane: the stage's spare height.
  const ySpan = Math.max(0.5, (availH * 0.5) / s);
  for (let c = 0; c < CLUSTERS; c += 1) {
    // Evenly round the space and evenly up and down it (a golden-ratio walk), so no angle of
    // the turn leaves a side of the picture empty.
    const phi = ((c + 0.4 * rnd(c, 1)) / CLUSTERS) * Math.PI * 2;
    const rho = 1.3 + rnd(c, 2) * 0.9;
    const x0 = Math.cos(phi) * rho;
    const y0 = (((c * 0.618 + 0.3) % 1) * 2 - 1) * ySpan * 0.8;
    const z0 = Math.sin(phi) * rho;
    // A knot's words stay a few cells apart at any size: fewer of them on a small raster.
    const size = Math.round((9 + rnd(c, 4) * 9) * Math.min(1.35, Math.max(0.8, s / 40)));
    const spread = 0.1 + rnd(c, 5) * 0.05;
    for (let i = 0; i < size; i += 1) {
      const id = c * 100 + i;
      words.push({
        x: x0 + gauss(id, 1) * spread,
        y: y0 + gauss(id, 2) * spread * 0.8,
        z: z0 + gauss(id, 3) * spread,
      });
    }
  }
  for (let i = 0; i < 14; i += 1) {
    const phi = rnd(i, 21) * Math.PI * 2;
    const rho = 1.25 + rnd(i, 22) * 1.1;
    words.push({ x: Math.cos(phi) * rho, y: (rnd(i, 23) * 2 - 1) * ySpan, z: Math.sin(phi) * rho });
  }

  const fill = (r: Raster, x0: number, y0: number, w: number, h: number, ink: number) => {
    const xa = Math.max(0, Math.round(x0));
    const ya = Math.max(0, Math.round(y0));
    const xb = Math.min(r.cols, Math.round(x0) + w);
    const yb = Math.min(r.rows, Math.round(y0) + h);
    for (let y = ya; y < yb; y += 1) for (let x = xa; x < xb; x += 1) r.ink[y * r.cols + x] = ink;
  };

  const LABEL_W = 19; // the card's number and a margin, in cells (3px): 16px pad + two glyphs
  const LABEL_H = 13;
  const PERIOD = 120; // one turn of the space, in seconds
  const STILL = 7; // the held frame (STILL_T): the words sit where ANGLES put them

  return {
    inks,
    draw(r, t) {
      const a = ((t - STILL) / PERIOD) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);

      // The vocabulary, far to near: a word a dot, dimmer and smaller the farther.
      const P = words.map((w) => project(w.x, w.y, w.z, ca, sa));
      const order = P.map((_, i) => i).sort((i, j) => P[j].zz - P[i].zz);
      for (const i of order) {
        const p = P[i];
        // A card's number, top left, is white pixel text: no word runs into it.
        if (card && p.sx < LABEL_W && p.sy < LABEL_H) continue;
        // One cell a word; on a large raster the nearest few grow to two, like the chips.
        const size = Math.max(1, Math.round(unit * p.f * 0.8 - 0.3));
        fill(r, p.sx, p.sy, size, size, p.zz > 0.3 ? I_RAIL : I_MUTED);
      }

      // The trails: each word's ring of distance, in its heat.
      rings.forEach((ring, k) => {
        for (const q of ring) {
          const p = project(q.x, 0, q.z, ca, sa);
          put(r, p.sx, p.sy, HEAT[k]);
        }
      });

      // The secret and its words, far to near, each chip cut out of what lies behind it.
      const secret = project(0, 0, 0, ca, sa);
      const items = near.map((n, k) => ({ k, p: project(n.x, 0, n.z, ca, sa) }));
      items.push({ k: -1, p: secret });
      items.sort((i, j) => j.p.zz - i.p.zz);
      for (const { k, p } of items) {
        if (k < 0) {
          // THE SECRET: the full hole's foil, its bands drifting.
          const w = 7 * unit;
          const h = 3 * unit;
          const x0 = Math.round(p.sx - w / 2);
          const y0 = Math.round(p.sy - h / 2);
          fill(r, x0 - 1, y0 - 1, w + 2, h + 2, 0);
          for (let y = 0; y < h; y += 1) {
            for (let x = 0; x < w; x += 1) {
              const band = (x - y * 0.8) / (9 * unit) - t * 0.12;
              const f = band - Math.floor(band);
              fill(r, x0 + x, y0 + y, 1, 1, f < 0.34 ? I_CYAN : f < 0.67 ? I_COBALT : I_ORCHID);
            }
          }
          continue;
        }
        const n = near[k];
        const w = Math.max(3, Math.round(n.w * p.f)); // a little wider in front, for depth
        const h = 2 * unit;
        const x0 = Math.round(p.sx - w / 2);
        const y0 = Math.round(p.sy - h / 2);
        fill(r, x0 - 1, y0 - 1, w + 2, h + 2, 0);
        fill(r, x0, y0, w, h, I_WHITE);
        // Its rank: a small block of heat at the chip's shoulder.
        fill(r, x0 + w, y0 - unit - 1, 2 * unit + 1, unit + 1, 0);
        fill(r, x0 + w + 1, y0 - unit, 2 * unit, unit, n.ink);
      }
    },
  };
};

export default distance;
