import { T0, noise3 } from '@whippin/shared';
import { COBALT, CYAN, DEEP, MUTED, ORCHID, RAIL, WHITE, clamp01, rect, rnd, th } from './kit';
import type { SceneMaker } from './kit';

// ------------------------------------------------------------------------ ATTENTION
// A sentence as a row of tokens; the focus token (the cyan chip) listens back — an arc to
// every token BEFORE it (the causal mask: what follows is dim and unheard), each arc as
// strong as its share of the attention: a dashed cobalt thread for a word barely heard, a
// full orchid ribbon for the one that matters. The shares drift as a softmax of slow noise,
// and the values run home along the arcs into the focus.

// One arc's cells, precomputed: its distance to the curve and where along it (0 = the token,
// len = the focus), so a frame only reads a list.
interface Arc {
  idx: Int32Array;
  d: Float32Array;
  s: Float32Array;
  core: Uint8Array;
  len: number;
}

// A cubic from the token's foot (rising straight up out of the word) over and down into the
// focus, sampled finely; every cell within `reach` keeps its nearest distance and arc length.
function buildArc(
  cols: number,
  rows: number,
  p: readonly [number, number, number, number, number, number, number, number],
  reach: number,
): Arc {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = p;
  const bestD = new Float32Array(cols * rows).fill(Infinity);
  const bestS = new Float32Array(cols * rows);
  const touched: number[] = [];
  const coreCells: number[] = [];
  const steps = Math.ceil((Math.abs(x3 - x0) + Math.abs(y1 - y0) * 2) * 3);
  let s = 0;
  let px = x0;
  let py = y0;
  const R = Math.ceil(reach);
  for (let i = 0; i <= steps; i += 1) {
    const k = i / steps;
    const m = 1 - k;
    const x = m * m * m * x0 + 3 * m * m * k * x1 + 3 * m * k * k * x2 + k * k * k * x3;
    const y = m * m * m * y0 + 3 * m * m * k * y1 + 3 * m * k * k * y2 + k * k * k * y3;
    s += Math.hypot(x - px, y - py);
    px = x;
    py = y;
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi >= 0 && yi >= 0 && xi < cols && yi < rows) {
      const c = yi * cols + xi;
      if (coreCells[coreCells.length - 1] !== c) coreCells.push(c);
    }
    for (let yy = yi - R; yy <= yi + R; yy += 1) {
      if (yy < 0 || yy >= rows) continue;
      for (let xx = xi - R; xx <= xi + R; xx += 1) {
        if (xx < 0 || xx >= cols) continue;
        const dd = Math.hypot(xx - x, yy - y);
        if (dd > reach) continue;
        const c = yy * cols + xx;
        if (bestD[c] === Infinity) touched.push(c);
        if (dd < bestD[c]) {
          bestD[c] = dd;
          bestS[c] = s;
        }
      }
    }
  }
  // The core, pixel-perfect: a cell whose two neighbours on the line touch diagonally is a
  // corner the eye reads as a lump — drop it.
  const kept: number[] = [];
  for (const c of coreCells) {
    kept.push(c);
    while (kept.length >= 3) {
      const a = kept[kept.length - 3];
      const b = kept[kept.length - 1];
      const dx = Math.abs((a % cols) - (b % cols));
      const dy = Math.abs(Math.floor(a / cols) - Math.floor(b / cols));
      if (dx <= 1 && dy <= 1) kept.splice(kept.length - 2, 1);
      else break;
    }
  }
  const core = new Set(kept);
  const n = touched.length;
  const arc: Arc = {
    idx: new Int32Array(n),
    d: new Float32Array(n),
    s: new Float32Array(n),
    core: new Uint8Array(n),
    len: s,
  };
  touched.forEach((c, i) => {
    arc.idx[i] = c;
    arc.d[i] = bestD[c];
    arc.s[i] = bestS[c];
    arc.core[i] = core.has(c) ? 1 : 0;
  });
  return arc;
}

const attention: SceneMaker = (cols, rows, stage) => {
  const inks = [WHITE, CYAN, ORCHID, COBALT, RAIL, MUTED, DEEP];
  const [I_WHITE, I_CYAN, I_ORCHID, I_COBALT, I_RAIL, I_MUTED, I_DEEP] = [1, 2, 3, 4, 5, 6, 7];
  const H = stage.h;
  const footed = rows > H;
  const u = Math.max(1, Math.round(Math.min(cols / 110, H / 50)));
  const n = 8;
  const focus = 5;
  // The row: tokens of varied length across the width.
  const mx = Math.round(cols * 0.1);
  const slot = (cols - mx - Math.round(cols * 0.06)) / n;
  const barH = 2 * u;
  const tokens = Array.from({ length: n }, (_, i) => {
    const w = Math.max(3 * u, Math.round(slot * (0.5 + rnd(i, 31) * 0.28)));
    const cx = Math.round(mx + slot * (i + 0.5));
    return { x: cx - Math.floor(w / 2), w, cx };
  });
  const f = tokens[focus];
  // The layers beneath: the same row again and again, thinner and fainter, down into the
  // depth (on a card, into its foot's fade).
  const pitch = 3 * u;
  const K = 2;
  // The vertical budget: the row at the bottom, the arcs over it, the block centred on the
  // stage above the fade.
  const top = Math.round(H * (footed ? 0.17 : 0.1));
  const bottom = footed ? H - 10 : H - Math.round(H * 0.08) - K * pitch;
  const spanMax = f.cx - tokens[0].cx;
  const reach = 1.2 * u + 2;
  // A tall stage lets the arcs stand taller; a wide one keeps them round.
  const Hmax = Math.min(
    bottom - top - barH - 2 * u - reach,
    spanMax * (0.62 + clamp01(H / cols - 0.5) * 0.45),
  );
  const block = Hmax + barH + 2 * u + reach;
  const rowY = Math.round(bottom - (bottom - top - block) / 2 - barH);
  // The curve's shape: out of the word straight up, over, and down into the focus at a slant
  // — the nearest steepest, the farthest the most gently — so the arcs fan into one point
  // instead of piling up. Scaled so the apex is `h`.
  const C1 = 1.25;
  const C2 = 0.95;
  let peak = 0;
  for (let k = 0; k <= 1; k += 0.01) {
    peak = Math.max(peak, 3 * (1 - k) * (1 - k) * k * C1 + 3 * (1 - k) * k * k * C2);
  }
  const arcs = Array.from({ length: focus }, (_, j) => {
    const span = f.cx - tokens[j].cx;
    const h = (Hmax * (span / spanMax) ** 0.88) / peak;
    const x0 = tokens[j].cx;
    const y0 = rowY - 1;
    const x3 = f.cx;
    const y3 = rowY - u - 1;
    const lean = 0.2 + 0.24 * (span / spanMax);
    return buildArc(cols, rows, [x0, y0, x0, y0 - h * C1, x3 - span * lean, y3 - h * C2, x3, y3], reach);
  });
  const PULSE = 8 * u; // cells a second
  // The ribbon: from the core (0.5) out to RMAX, in rings of whole cells; BAND is the share,
  // against the strongest, where a thread turns into a ribbon.
  const RMAX = 1.2 * u + 0.25;
  const RINGS = [0.5, 1.05, 1.55, 2.1, 2.6, 3.1, 3.6].filter((v) => v <= RMAX + 0.01);
  const BAND = 0.76;
  const DASH = u + 2; // a dashed thread's period, cells
  return {
    inks,
    draw(r, t) {
      const ink = r.ink;
      // The layers beneath: the same row, fainter at each depth, the focus carried through.
      for (let k = K; k >= 1; k -= 1) {
        const y = rowY + barH + k * pitch - u;
        tokens.forEach((tok, i) => {
          if (i === focus) rect(r, tok.x - u, y, tok.w + 2 * u, u, k === 1 ? I_COBALT : I_DEEP);
          else if (i < focus) rect(r, tok.x, y, tok.w, u, k === 1 ? I_RAIL : I_DEEP);
          else if (k === 1) rect(r, tok.x, y, tok.w, u, I_DEEP);
        });
      }
      // The shares: a softmax of drifting scores over the tokens the focus can hear, each seen
      // against the strongest; the weakest drawn first, so the one that matters lies on top.
      const g = arcs.map((_, j) => Math.exp(4.2 * noise3(j * 1.9, 3.3, T0 + t * 0.11)));
      const gmax = Math.max(...g);
      const order = arcs.map((_, j) => j).sort((p, q) => g[p] - g[q]);
      for (const j of order) {
        const arc = arcs[j];
        const gj = g[j] / gmax;
        // Weak: a dashed thread, sparser the weaker; then a solid thread; then, near the top, an
        // orchid ribbon widening ring by ring — hard-edged, a ring dithered in only while it is
        // arriving, never a fuzz.
        const dash = gj >= 0.45 ? 1 : 0.2 + gj * 1.7;
        const R =
          gj < BAND
            ? 0.5
            : gj < BAND + 0.06
              ? 0.5 + ((gj - BAND) / 0.06) * 0.55
              : 1.05 + ((gj - BAND - 0.06) / (0.94 - BAND)) * (RMAX - 1.05);
        let lo = 0;
        while (lo + 1 < RINGS.length && RINGS[lo + 1] <= R) lo += 1;
        // A thread is its pixel-perfect core alone (no ring inside); a ribbon every cell to `rin`.
        const rin = lo === 0 ? 0 : RINGS[lo];
        const rout = lo + 1 < RINGS.length ? RINGS[lo + 1] : RINGS[lo];
        const frac = rout > RINGS[lo] ? (R - RINGS[lo]) / (rout - RINGS[lo]) : 0;
        const orchid = clamp01((gj - BAND) / 0.06);
        // The value's pulse: from the token (s = 0) home to the focus (s = len), then a rest.
        const period = arc.len / PULSE + 2.2;
        const ps = ((t + rnd(j, 41) * period) % period) * PULSE;
        const plen = dash < 1 ? 1.5 * DASH : (0.8 + gj * 1.6) * u;
        const prad = R * 0.5;
        for (let i = 0; i < arc.idx.length; i += 1) {
          const d = arc.d[i];
          const c = arc.idx[i];
          const s = arc.s[i];
          const core = arc.core[i] === 1;
          // A heard word's value runs home white; a faint one's only closes its dashes as it
          // passes — alive, but quiet.
          const pulse = Math.abs(s - ps) < plen && (core || d <= prad);
          if (pulse && dash >= 1) {
            ink[c] = I_WHITE;
            continue;
          }
          const lim = th(c % cols, (c / cols) | 0);
          if (core ? !pulse && dash < 1 && (s / DASH) % 1 >= dash : d > rin && (d > rout || frac <= lim)) {
            // The knockout: a cell of ground around the arc over the weaker ones drawn before
            // it, so where they converge they pass under it instead of fraying into a band.
            if (d <= (rin > 0 ? rin + 1.6 : 2.1)) ink[c] = 0;
            continue;
          }
          ink[c] = orchid > lim ? I_ORCHID : I_COBALT;
        }
      }
      // The row itself: the word most heard lit white, the others grey, the focus a cyan
      // chip, the words after it dim — unheard.
      tokens.forEach((tok, i) => {
        if (i === focus) {
          rect(r, tok.x - u, rowY - u, tok.w + 2 * u, barH + 2 * u, I_CYAN);
          return;
        }
        if (i > focus) {
          rect(r, tok.x, rowY, tok.w, barH, I_RAIL);
          return;
        }
        rect(r, tok.x, rowY, tok.w, barH, I_MUTED);
        rect(r, tok.x, rowY, tok.w, barH, I_WHITE, (g[i] / gmax - BAND) / 0.06);
      });
    },
  };
};

export default attention;
