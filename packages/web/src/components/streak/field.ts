import { bayerThreshold as th } from '@whippin/shared';
import { BAR_REACH, LINK_H, LINK_W, linkCellsAt } from './sprites';
import { clamp01 } from './beats';
import { weekPath, type Box, type Layout, type WeekPath } from './geometry';

// THE STREAK CELEBRATION'S FIELD — the raster's cells, MEASURED ONCE per scene, so a frame
// (`scene.ts`) only reads: each cell's dither threshold, how far the words and the frame push
// the orbits back, its distance from the count (for the shock) with a radius-bucketed index
// for the rings that cross the whole screen, the cells along the week's own path with their
// place along it, and every cell each day's link covers. Space only — nothing here knows the
// clock or which days are solved.

// A box the orbits leave bare (cells), dithering back in over `margin`.
export interface ClearRect extends Box {
  margin: number;
  // The subject's own room (the count, the links, the crown): the orbits and the shock keep
  // off it, the forge's sparks and glitter do not. Anything else — the words, the frame —
  // keeps every effect off.
  subject?: boolean;
}

// A link's metal cell, measured once — where it lands, which face (the metal or its
// under-face), its dither order, how high in the link (the pour rises), its place on the
// link's diagonal (the foil's) and along the path (a glint's).
export interface LinkCell {
  i: number;
  x: number;
  y: number;
  deep: boolean;
  ghost: boolean; // in the empty link a day to come shows
  cut: boolean; // open in the link a day missed shows
  order: number;
  rise: number;
  u: number;
  s: number;
}

export interface Field {
  n: number;
  TH: Float32Array; // each cell's Bayer threshold
  R: Float32Array; // its distance from the count's centre
  CLEAR: Float32Array; // 1 = bare, 0 = free, between = dithered back in
  WORDS: Uint8Array; // 1 = a word or the frame: no effect lands here
  maxR: number; // the farthest corner from the count
  // Visit every cell whose distance from the count is in [r0, r1).
  withinRadius: (r0: number, r1: number, visit: (i: number) => void) => void;
  path: WeekPath;
  cellAlong: number; // one cell, along the path
  reachAlong: number; // BAR_REACH cells, along
  // THE WEEK'S BAND: the cells on the path, each with its place ALONG it and its signed
  // distance from it (cells; positive outward, away from the count).
  weekBand: number[];
  bandS: Float32Array;
  bandOff: Float32Array;
  pointAt: (sv: number) => { x: number; y: number };
  // Where the orbit's lower left leaves the frame (or turns): the run carried in from last
  // week shows from there into Monday (a place along the orbit past Sunday, 0–1).
  tailFrom: number;
  // |angle| in [seenA, π − seenA] is on screen: the arcs of the orbit a phone shows.
  seenA: number;
  cover: Int8Array; // the day whose link covers a cell (hole included), -1 none
  hole: Uint8Array; // 1 = a link's open hole: an edge-on link may show there
  nearLink: Uint8Array; // 1 = a cell beside a link's outline (outside it)
  linkCells: LinkCell[][]; // each day's metal, Monday first
}

export function measureField(L: Layout, clear: readonly ClearRect[]): Field {
  const { cols, rows, cx, ring, links } = L;
  const ccy = L.countCy;
  const maxR =
    Math.max(Math.hypot(cx, ccy), Math.hypot(cols - cx, ccy), Math.hypot(cx, rows - ccy), Math.hypot(cols - cx, rows - ccy)) + 2;

  const n = cols * rows;
  const TH = new Float32Array(n);
  const R = new Float32Array(n);
  const CLEAR = new Float32Array(n);
  const WORDS = new Uint8Array(n);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const i = y * cols + x;
      TH[i] = th(x, y);
      R[i] = Math.hypot(x + 0.5 - cx, y + 0.5 - ccy);
    }
  }
  for (const r of clear) {
    const m = Math.max(1, r.margin);
    for (let y = Math.max(0, Math.floor(r.y0 - m)); y < Math.min(rows, Math.ceil(r.y1 + m)); y += 1) {
      for (let x = Math.max(0, Math.floor(r.x0 - m)); x < Math.min(cols, Math.ceil(r.x1 + m)); x += 1) {
        const ox = Math.max(r.x0 - (x + 0.5), 0, x + 0.5 - r.x1);
        const oy = Math.max(r.y0 - (y + 0.5), 0, y + 0.5 - r.y1);
        const v = clamp01(1 - Math.hypot(ox, oy) / m);
        const i = y * cols + x;
        if (v > CLEAR[i]) CLEAR[i] = v;
        if (!r.subject && v > 0.5) WORDS[i] = 1;
      }
    }
  }
  // The frame's top band, the lockup's row, is bare of every orbit and ring on any screen;
  // they dither back in under it.
  {
    const foot = L.topBand / L.cell - 1;
    const fade = 18 / L.cell;
    for (let y = 0; y < Math.min(rows, Math.ceil(foot + fade)); y += 1) {
      const v = clamp01(1 - (y + 0.5 - foot) / fade);
      for (let x = 0; x < cols; x += 1) if (v > CLEAR[y * cols + x]) CLEAR[y * cols + x] = v;
    }
  }
  // The cells bucketed by whole radius (a counting sort, linear in the screen): a ring of
  // radius [r0, r1) then reads only its buckets.
  const buckets = Math.ceil(maxR) + 2;
  const bucketAt = new Uint32Array(buckets + 1);
  for (let i = 0; i < n; i += 1) bucketAt[Math.floor(R[i]) + 1] += 1;
  for (let b = 1; b <= buckets; b += 1) bucketAt[b] += bucketAt[b - 1];
  const byR = new Uint32Array(n);
  {
    const fill = bucketAt.slice(0, buckets);
    for (let i = 0; i < n; i += 1) byR[fill[Math.floor(R[i])]++] = i;
  }
  const withinRadius = (r0: number, r1: number, visit: (i: number) => void) => {
    const b1 = Math.min(buckets - 1, Math.floor(r1));
    for (let b = Math.max(0, Math.floor(r0)); b <= b1; b += 1) {
      for (let j = bucketAt[b]; j < bucketAt[b + 1]; j += 1) {
        const i = byR[j];
        if (R[i] >= r0 && R[i] < r1) visit(i);
      }
    }
  };

  // THE WEEK'S PATH: its cells, each with its place ALONG it and its signed distance from it.
  const path = weekPath(L);
  const { dayAlong, weekEnd, crownAlong } = path;
  const cellAlong = 1 / path.length;
  const bandBest = new Float32Array(n).fill(99);
  const bandS = new Float32Array(n);
  const bandOff = new Float32Array(n);
  for (let j = 0; j < path.x.length; j += 1) {
    const px = path.x[j];
    const py = path.y[j];
    for (let y = Math.max(0, Math.floor(py - 2)); y <= Math.min(rows - 1, Math.floor(py + 2)); y += 1) {
      for (let x = Math.max(0, Math.floor(px - 2)); x <= Math.min(cols - 1, Math.floor(px + 2)); x += 1) {
        const dx = x + 0.5 - px;
        const dy = y + 0.5 - py;
        const d = Math.hypot(dx, dy);
        const i = y * cols + x;
        if (d < bandBest[i]) {
          bandBest[i] = d;
          bandS[i] = path.s[j];
          bandOff[i] = dx * path.nx[j] + dy * path.ny[j];
        }
      }
    }
  }
  const weekBand: number[] = [];
  for (let i = 0; i < n; i += 1) if (bandBest[i] <= 1.3) weekBand.push(i);
  // A place along the path, as a point (for the comet's head).
  const pointAt = (sv: number) => {
    let lo = 0;
    let hi = path.s.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (path.s[mid] <= sv) lo = mid;
      else hi = mid;
    }
    const span = path.s[hi] - path.s[lo] || 1;
    const f = clamp01((sv - path.s[lo]) / span);
    return { x: path.x[lo] + (path.x[hi] - path.x[lo]) * f, y: path.y[lo] + (path.y[hi] - path.y[lo]) * f };
  };
  let tailFrom = 0.97;
  {
    let minX = Infinity;
    let minS = 1;
    for (let j = 0; j < path.x.length; j += 1) {
      if (path.s[j] <= crownAlong) continue;
      if (path.x[j] < minX) {
        minX = path.x[j];
        minS = path.s[j];
      }
      if (path.x[j] < 1) {
        minS = path.s[j];
        break;
      }
    }
    tailFrom = Math.min(0.97, Math.max(0.55, (minS - weekEnd) / (1 - weekEnd)));
  }
  const seen = Math.min(1, (cols / 2 - 3) / ring.rx);
  const seenA = Math.acos(seen);

  // THE LINKS: each sprite's cells. Every cell a link covers, hole included, keeps the
  // orbit's rails out of it.
  const cover = new Int8Array(n).fill(-1);
  const hole = new Uint8Array(n);
  const linkCells: LinkCell[][] = links.map((l, li) => {
    const cells: LinkCell[] = [];
    for (const { x, y, lx, ly, part, ghost, cut } of linkCellsAt(l)) {
      if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
      const i = y * cols + x;
      cover[i] = li;
      if (part === 'hole') {
        hole[i] = 1;
        continue;
      }
      cells.push({
        i,
        x,
        y,
        deep: part === 'deep',
        ghost,
        cut,
        order: TH[i],
        rise: 1 - ly / (LINK_H - 1),
        u: (lx + ly * 0.9) / (LINK_W + LINK_H * 0.9),
        s: dayAlong[li] + (x + 0.5 - l.x) * cellAlong,
      });
    }
    return cells;
  });
  // A cell beside a link's outline (outside it): the dotted rail keeps a cell off every link,
  // so a ghost's dashes stay its own.
  const nearLink = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    if (cover[i] < 0) continue;
    const x = i % cols;
    const y = (i - x) / cols;
    for (let dy = -1; dy <= 1; dy += 1)
      for (let dx = -1; dx <= 1; dx += 1) {
        const X = x + dx;
        const Y = y + dy;
        if (X >= 0 && Y >= 0 && X < cols && Y < rows && cover[Y * cols + X] < 0) nearLink[Y * cols + X] = 1;
      }
  }

  return {
    n,
    TH,
    R,
    CLEAR,
    WORDS,
    maxR,
    withinRadius,
    path,
    cellAlong,
    reachAlong: BAR_REACH * cellAlong,
    weekBand,
    bandS,
    bandOff,
    pointAt,
    tailFrom,
    seenA,
    cover,
    hole,
    nearLink,
    linkCells,
  };
}
