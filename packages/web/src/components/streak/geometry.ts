import { GLYPH_GAP, GLYPH_ROWS, type DigitMask } from '../digitMasks';
import { LINK_H, LINK_PITCH, LINK_PITCH_TIGHT, LINK_W, type Crown, type LinkPlace } from './sprites';

// THE STREAK CELEBRATION'S GEOMETRY — where everything stands, solved once per screen size,
// in whole cells: the count's face, the WEEK'S ORBIT and the chain along its floor, the crown
// at its top, the past weeks' orbits around it, and where the DOM words go (CSS px). Plus the
// orbit measured as ONE closed path the beats travel (`weekPath`). Pure numbers, no drawing.

// ── The number as cells ───────────────────────────────────────────────────────────────────
// A count's glyphs side by side, one bit per glyph pixel.
export interface NumberCells {
  w: number;
  h: number;
  bits: Uint8Array;
}

export function numberCells(glyphs: readonly DigitMask[] | null, value: number): NumberCells {
  const digits = Array.from(String(value), (c) => Number(c));
  if (!glyphs) {
    // No glyphs (the sheet failed to decode): a count's width and no ink — the dialog sets
    // the number as type instead.
    const w = digits.length * 8 - 1;
    return { w, h: GLYPH_ROWS, bits: new Uint8Array(w * GLYPH_ROWS) };
  }
  const w = digits.reduce((sum, d) => sum + glyphs[d].w, 0) + GLYPH_GAP * (digits.length - 1);
  const bits = new Uint8Array(w * GLYPH_ROWS);
  let x0 = 0;
  for (const d of digits) {
    const m = glyphs[d];
    for (let y = 0; y < GLYPH_ROWS; y += 1)
      for (let x = 0; x < m.w; x += 1) bits[y * w + x0 + x] = m.rows[y * m.w + x];
    x0 += m.w + GLYPH_GAP;
  }
  return { w, h: GLYPH_ROWS, bits };
}

// The width the face is sized for: never less than a three-digit count's (`1` + two full
// digits: 6 + 1 + 7 + 1 + 7), so 9 → 10 and 99 → 100 land at the same size and a hundredth
// day is never smaller than a tenth.
export const RESERVE_BITS = 22;

// ── Cells and boxes ───────────────────────────────────────────────────────────────────────
// Cells are whole CSS pixels: 3 on a phone (either way up), 4 from a tablet up (the level
// art's 3, the cards' orbit 4) — chosen by the screen's short side, never fractional.
function cellFor(width: number, height: number): number {
  return Math.min(width, height) >= 600 ? 4 : 3;
}

const GUTTER_PX = 16;
// One glyph pixel never larger than the share card's (160px face = 20px a pixel).
const MAX_GLYPH_PX = 20;
// The ULTRA star's frame (`ultra-slash.png`, 71×66) and its whole scales.
export const STAR_W = 71;
export const STAR_H = 66;

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function overlaps(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

// ── The week's orbit ──────────────────────────────────────────────────────────────────────
// One closed curve about (cx, cy), in cells. Its upper half is the cards' ellipse (rx, ry),
// through the crown's foot; its lower half a SUPERELLIPSE (rx, ryL and an exponent p: 2 is
// the ellipse, more is squarer) — flatter across its floor, rounder at its two lower corners
// — which the chain lies along. The halves meet at the orbit's widest, both upright there,
// and the chain's two end links sit ON the lower half, leaving it at their own lean: the loop
// has no corner.
export interface Ring {
  cy: number;
  rx: number;
  ry: number; // the upper half's height
  ryL: number; // the lower half's depth
  p: number; // the lower half's exponent
}

// A point of the orbit at angle `a` (screen angle: positive is down), as an offset from its
// centre. The upper half runs on the ellipse's own parameter; the lower on the polar angle,
// so a square-cornered floor is sampled evenly.
export function ringXY(r: Ring, a: number): [number, number] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  if (s <= 0) return [r.rx * c, r.ry * s];
  const k = (Math.abs(c / r.rx) ** r.p + (s / r.ryL) ** r.p) ** (-1 / r.p);
  return [k * c, k * s];
}
// The same orbit grown `d` cells down its height and `sx·d` across (a past week's) — its
// floor rounding back toward the ellipse: only the week's own carries a chain — or scaled
// (the heartbeat's).
const grownRing = (r: Ring, d: number, sx: number): Ring => ({
  ...r,
  rx: r.rx + sx * d,
  ry: r.ry + d,
  ryL: r.ryL + d,
  p: 2 + (r.p - 2) * 0.3,
});
export const scaledRing = (r: Ring, g: number): Ring => ({ ...r, rx: r.rx * g, ry: r.ry * g, ryL: r.ryL * g });

// The lower half through the point (X, Y) — offsets from the centre, Y down — leaving it at
// slope `m`: the exponent is the one whose curve leans exactly so there (the lean falls as p
// grows), the depth the one that puts the curve through the point.
const P_MAX = 8;
function lowerHalf(X: number, Y: number, rx: number, m: number): { p: number; ryL: number } {
  const u = Math.min(0.995, Math.abs(X) / rx);
  const lean = (p: number) => ((Y / rx) * u ** (p - 1)) / (1 - u ** p);
  let p = 2;
  if (lean(2) > m) {
    if (lean(P_MAX) > m) p = P_MAX;
    else {
      let lo = 2;
      let hi = P_MAX;
      for (let k = 0; k < 32; k += 1) {
        const mid = (lo + hi) / 2;
        if (lean(mid) > m) lo = mid;
        else hi = mid;
      }
      p = hi;
    }
  }
  return { p, ryL: Y / (1 - u ** p) ** (1 / p) };
}

// ── Where the chain lies ──────────────────────────────────────────────────────────────────
// The chain's PLACEMENT, decided here alone — laying it elsewhere is this function. ON THE
// ARC, the orbit's floor: each day's link stands `rise` whole cells above the chain's foot,
// Monday first — a smile, Thursday lowest, never more than two cells between neighbours, so
// an edge-on link always threads both holes straight or with one step. The orbit leaves the
// end links at `endLean`, steep enough that the loop stays the cards' ellipse (the turn from
// the chain's own last lean made inside the end link, where the link hides it), and is as
// wide as a card's orbit is for its height (`orbitRx`). The open alternative, a straight ROW
// under DAY STREAK, is rise all 0, an end lean of 0.22, and the orbit a link's width (+2)
// past the chain's ends.
export interface ChainPlacement {
  rise: readonly number[];
  endLean: number;
  orbitRx: (ry: number, chainHalf: number) => number;
}
export function chainPlacement(): ChainPlacement {
  return {
    rise: [5, 3, 1, 0, 1, 3, 5],
    endLean: 0.45,
    orbitRx: (ry, chainHalf) => Math.max(ry * 2.4, chainHalf + LINK_W),
  };
}

// ── The layout ────────────────────────────────────────────────────────────────────────────
export interface Layout {
  width: number;
  height: number;
  cell: number;
  cols: number;
  rows: number;
  cx: number; // the centre column (a cell corner, so the drawing is symmetric)
  k: number; // cells per glyph pixel
  countTop: number; // cells
  countCy: number; // the count's centre row, cells
  pitch: number; // the chain's pitch, cells
  ring: Ring; // the week's orbit
  links: LinkPlace[]; // the 7 days, Monday first
  crown: Crown; // the flame's foot, height, half-width (cells)
  // Where the past weeks' orbits may run (cells grown down the orbit's height; see pastOrbits).
  orbitBand: { inner: number; outer: number; sx: number; minStep: number };
  // DOM placements, CSS px.
  unitY: number; // DAY STREAK's centre line
  unitSize: number;
  labels: { x: number; y: number }[]; // each day's initial, under its link, on one line
  hintY: number;
  starScale: number;
  topBand: number; // the lockup's row ends here
}

// Where the ending hint stands, from the foot (CSS px).
const hintFromFoot = (height: number) => (height < 500 ? 28 : Math.max(48, Math.round(height * 0.075)));

// The orbit's widest stays inside the gutters — or, when the chain needs more room than
// they leave, this many cells inside the screen's edge.
const ORBIT_EDGE = 2;
// CSS px between the links' foot and the initials; the initials' line height.
const LABEL_GAP = 8;
const LABEL_H = 18;
// The past weeks' orbits keep at least this far apart, and this far under the lockup's row
// (CSS px).
const ORBIT_MIN_STEP_PX = 26;
const ORBIT_TOP_CLEAR_PX = 14;

// The whole picture's placement, solved once per screen size: the largest whole face that
// lets the crown, the count, its unit, the week and its initials stand between the lockup's
// row and the hint, with the ultra star (struck on a day) clear of the count and its unit.
// `sizing` is the width (glyph pixels) the face is sized for, `countBits` the widest count's.
export function layout(width: number, height: number, sizing: number, countBits = sizing): Layout {
  const cell = cellFor(width, height);
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const cx = Math.round(cols / 2);
  // The ultra star at its sheet's own size on a phone (it frames the struck link, never
  // erases it), the next whole scale wider.
  const starScale = cell === 4 ? 2 : 1;
  const starHalfH = (STAR_H * starScale) / 2;
  const starHalfW = (STAR_W * starScale) / 2;
  const unitSize = cell === 4 ? 16 : 13;
  const unitH = Math.round(unitSize * 0.8);
  const topBand = height < 500 ? 48 : cell === 4 ? 92 : 64;
  const hintY = height - hintFromFoot(height);
  const bottomLimit = hintY - (height < 500 ? 18 : 30);
  const chain = chainPlacement();
  const riseMax = Math.max(...chain.rise);

  // The days stand at the chain's pitch, Thursday under the count, each centre on a cell's
  // middle so its sprite lands whole, each risen off the chain's foot (`rowY`) by its cells.
  // The wider pitch only where the orbit keeps a link's width of room past the chain's ends.
  const roomRx = Math.min(cx, cols - cx) - ORBIT_EDGE;
  const pitch = roomRx >= 3 * LINK_PITCH + LINK_W / 2 + LINK_W ? LINK_PITCH : LINK_PITCH_TIGHT;
  const dayX = (i: number) => cx + (i - 3) * pitch + 0.5;
  const unitHalfW = (10 * 0.78 * unitSize) / 2 + 2;

  // The largest face whose whole stack fits (a face of one cell a glyph pixel always does):
  // the crown, the count, its unit, the week — the arc's rise included — and its initials.
  const fit = (k: number) => {
    const gp = k * cell;
    const countH = GLYPH_ROWS * gp;
    const unitGap = Math.max(12, Math.round(countH * 0.17));
    // The chain's highest link stands far enough under the unit for the star to clear it;
    // the arc's rise hangs the rest below.
    const rowGap = unitGap + unitH + Math.max(starHalfH, LINK_H * cell * 0.5 + 16) + 4;
    const ringGap = Math.max(4 * cell, Math.round(countH * 0.24));
    const flameH = Math.round(countH * 0.72);
    // The ultra star, struck on any day, must clear the count and its unit (CSS px boxes,
    // measured from the count's top, with a few pixels of air round the unit): the chain's
    // foot steps down a cell at a time until it does. `drop` is that foot, in cells under
    // the count's foot.
    const countBox: Box = {
      x0: (cx - (countBits * k) / 2) * cell,
      y0: 0,
      x1: (cx + (countBits * k) / 2) * cell,
      y1: countH,
    };
    const unitY = countH + unitGap + unitH / 2;
    const unitBox: Box = {
      x0: cx * cell - unitHalfW - 4,
      y0: unitY - unitH / 2 - 4,
      x1: cx * cell + unitHalfW + 4,
      y1: unitY + unitH / 2 + 4,
    };
    const starHits = (drop: number) =>
      chain.rise.some((rise, i) => {
        const x = dayX(i) * cell;
        const y = (GLYPH_ROWS * k + drop - rise) * cell;
        const s: Box = { x0: x - starHalfW, y0: y - starHalfH, x1: x + starHalfW, y1: y + starHalfH };
        return overlaps(s, countBox) || overlaps(s, unitBox);
      });
    let drop = Math.round(rowGap / cell) + riseMax;
    for (let guard = 0; guard < 40 && starHits(drop); guard += 1) drop += 1;
    // From the crown's tip to the initials' foot, a cell spare for the count's top landing
    // on a whole cell.
    const total = flameH + ringGap + countH + (drop + LINK_H / 2 + 1) * cell + LABEL_GAP + LABEL_H;
    const fits = sizing * gp <= width - 2 * GUTTER_PX && total <= bottomLimit - topBand;
    return { k, unitGap, ringGap, flameH, drop, total, fits };
  };
  let f = fit(1);
  for (let k = Math.floor(MAX_GLYPH_PX / cell); k > 1; k -= 1) {
    const tried = fit(k);
    if (tried.fits) {
      f = tried;
      break;
    }
  }
  // The group sits a touch above the middle: the optical centre.
  const groupTop = topBand + Math.max(0, (bottomLimit - topBand - f.total) * 0.46);
  const countTop = Math.round((groupTop + f.flameH + f.ringGap) / cell);
  const countBottom = countTop + GLYPH_ROWS * f.k;
  const unitY = countBottom * cell + f.unitGap + unitH / 2;
  const ringTop = countTop - Math.round(f.ringGap / cell);

  const chainHalf = 3 * pitch + LINK_W / 2;
  const countHalf = (countBits * f.k) / 2;
  // Never wider than the screen: the orbit is a closed shape on every phone.
  const gutter = Math.ceil(GUTTER_PX / cell);
  const maxRx = Math.min(
    Math.min(cx, cols - cx) - ORBIT_EDGE,
    Math.max(Math.min(cx, cols - cx) - gutter - 1, chainHalf + 2),
  );
  const rowY = countBottom + f.drop;
  const links = Array.from({ length: 7 }, (_, i): LinkPlace => ({ x: dayX(i), y: rowY - chain.rise[i] }));
  // The orbit's middle halfway between the crown's foot and the chain's foot.
  const cy = (rowY + ringTop) / 2;
  const ry = cy - ringTop;
  // As the chain wants it — and always clear of the count and of the chain's own ends.
  const rx = Math.min(maxRx, Math.max(chain.orbitRx(ry, chainHalf), countHalf + 4, chainHalf + 2));
  const { p, ryL } = lowerHalf(3 * pitch, rowY - chain.rise[6] - cy, rx, chain.endLean);
  const ring: Ring = { cy, rx, ry, ryL, p };
  // The initials on ONE line under the chain's foot, each under its own link — the calendar's
  // row, read at a glance; today's title chip sits on the same line.
  const labelY = Math.round((rowY + LINK_H / 2) * cell + LABEL_GAP + LABEL_H / 2);
  const labels = links.map((n) => ({ x: n.x * cell, y: labelY }));
  const labelsFoot = labelY + LABEL_H / 2;

  // THE PAST WEEKS' BAND: the orbits outside the week's — the first clear of the initials,
  // the last clear of the lockup's row and the hint — grown by `d` cells down their height
  // and `sx·d` across, so they stretch toward the screen's long side.
  const sx = Math.min(1.8, Math.max(0.4, width / height));
  const floor = ring.cy + Math.max(ring.ryL, rowY - ring.cy);
  const inner = Math.max(2, (labelsFoot + 16) / cell - floor);
  const outer = Math.min(
    ring.cy - ring.ry - (ORBIT_TOP_CLEAR_PX + topBand) / cell,
    (hintY - 30) / cell - floor,
  );
  const orbitBand = { inner, outer: Math.max(inner, outer), sx, minStep: ORBIT_MIN_STEP_PX / cell };

  return {
    width,
    height,
    cell,
    cols,
    rows,
    cx,
    k: f.k,
    countTop,
    countCy: countTop + (GLYPH_ROWS * f.k) / 2,
    pitch,
    ring,
    links,
    crown: { x: cx, y: ringTop, h: Math.round(f.flameH / cell), w: Math.max(5, Math.round(f.flameH / cell / 3.4)) },
    orbitBand,
    unitY,
    unitSize,
    labels,
    hintY,
    starScale,
    topBand,
  };
}

// THE PAST WEEKS' ORBITS for a run that crossed `weeks` earlier weeks: one each, innermost
// the last, spread evenly across the band — as many as keep their distance, four at most on a
// phone and five wider. Each is the week's own orbit, grown.
export function pastOrbits(L: Layout, weeks: number): Ring[] {
  const { inner, outer, sx, minStep } = L.orbitBand;
  const room = Math.max(0, outer - inner);
  const n = Math.min(weeks, L.cell === 4 ? 5 : 4, Math.max(1, Math.floor(room / minStep)));
  if (n <= 0) return [];
  const step = room / n;
  return Array.from({ length: n }, (_, i) => grownRing(L.ring, inner + step * (i + 0.5), sx));
}

// How many earlier weeks the run has crossed: none while it began this week.
export function pastWeeks(streak: number, todayIndex: number): number {
  const before = streak - (todayIndex + 1);
  return before > 0 ? Math.ceil(before / 7) : 0;
}

// Where a count's top-left cell sits: centred on the column, both counts on one top line so
// the landing never jumps a row.
export function numberPlace(L: Layout, m: NumberCells): { x: number; y: number } {
  return { x: Math.round(L.cx - (m.w * L.k) / 2), y: L.countTop };
}

// ── The week's path ───────────────────────────────────────────────────────────────────────
// The orbit as ONE closed path the beats travel, measured in its own length: 0 at Monday's
// link, along the chain through every link's centre to Sunday's (`weekEnd`), then on out of
// it up round the crown and down again into Monday at 1.
export interface WeekPath {
  x: Float32Array;
  y: Float32Array;
  nx: Float32Array; // the outward normal (away from the count)
  ny: Float32Array;
  s: Float32Array; // 0–1 along
  length: number; // cells
  dayAlong: number[];
  weekEnd: number;
  crownAlong: number;
}

const PATH_STEP = 0.25;

export function weekPath(L: Layout): WeekPath {
  const { cx, ring, links } = L;
  const pts: number[] = [];
  const push = (x: number, y: number) => {
    const n = pts.length;
    if (n >= 2 && Math.abs(pts[n - 2] - x) < 1e-6 && Math.abs(pts[n - 1] - y) < 1e-6) return;
    pts.push(x, y);
  };
  const line = (x0: number, y0: number, x1: number, y1: number) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / PATH_STEP));
    for (let k = 0; k <= steps; k += 1) push(x0 + ((x1 - x0) * k) / steps, y0 + ((y1 - y0) * k) / steps);
  };
  // The chain: link to link, centre to centre.
  for (let i = 0; i < 6; i += 1) line(links[i].x, links[i].y, links[i + 1].x, links[i + 1].y);
  // The orbit, out of Sunday's link round the top and back into Monday's (angles decreasing:
  // up the right side, over the crown, down the left), each step a fraction of a cell.
  const aSun = Math.atan2(links[6].y - ring.cy, links[6].x - cx);
  const aMon = Math.atan2(links[0].y - ring.cy, links[0].x - cx) - Math.PI * 2;
  let prev = ringXY(ring, aSun);
  line(links[6].x, links[6].y, cx + prev[0], ring.cy + prev[1]);
  const fine = Math.ceil(((aSun - aMon) * Math.max(ring.rx, ring.ry, ring.ryL) * 3) / PATH_STEP);
  for (let k = 1; k <= fine; k += 1) {
    const p = ringXY(ring, aSun + ((aMon - aSun) * k) / fine);
    line(cx + prev[0], ring.cy + prev[1], cx + p[0], ring.cy + p[1]);
    prev = p;
  }
  line(cx + prev[0], ring.cy + prev[1], links[0].x, links[0].y);
  const n = pts.length / 2;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const s = new Float32Array(n);
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    x[i] = pts[2 * i];
    y[i] = pts[2 * i + 1];
    if (i > 0) total += Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
    s[i] = total;
  }
  for (let i = 0; i < n; i += 1) s[i] /= total;
  const nx = new Float32Array(n);
  const ny = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const a = Math.max(0, i - 2);
    const b = Math.min(n - 1, i + 2);
    const tx = x[b] - x[a];
    const ty = y[b] - y[a];
    const l = Math.hypot(tx, ty) || 1;
    nx[i] = -ty / l;
    ny[i] = tx / l;
  }
  const nearest = (px: number, py: number, from: number) => {
    let best = Infinity;
    let at = 0;
    for (let i = 0; i < n; i += 1) {
      if (s[i] < from) continue;
      const d = (x[i] - px) ** 2 + (y[i] - py) ** 2;
      if (d < best) {
        best = d;
        at = s[i];
      }
    }
    return at;
  };
  // Monday's own place is the start (its nearest point might be the loop's end, at 1).
  const dayAlong = links.map((l, i) => (i === 0 ? 0 : nearest(l.x, l.y, 0)));
  const weekEnd = dayAlong[6];
  const crownAlong = nearest(cx, ring.cy - ring.ry, weekEnd);
  return { x, y, nx, ny, s, length: total, dayAlong, weekEnd, crownAlong };
}
