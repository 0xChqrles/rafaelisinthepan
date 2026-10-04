import { HOLO_INKS, T0, bayerThreshold as th, hash3, noise3 } from '@whippin/shared';
import {
  CROWN_MS,
  CROWN_STEPS,
  FLARE,
  FLARE_MS,
  RELAY_FLARE,
  RELAY_FLARE_MS,
  WEEK_SWEEP_MS,
  WRAP_SWEEP_MS,
  at,
  backOut,
  clamp01,
  type Timeline,
} from './beats';
import { hexToAbgr } from '../raster';

// THE STREAK CELEBRATION'S INKS AND SPRITES — the small drawn things the scene (`scene.ts`)
// stamps into its raster: the inks themselves (the app's tokens, nothing else), the chain's
// LINK in its three states, the FOIL as a cell material, the glitter's four-point star, and
// the crown's FLAME. Pixel art does not rotate, fade or scale: each is whole cells in solid
// inks, stepped.

// ── The inks: the tokens, nothing else ────────────────────────────────────────────────────
// Indices into the scene's raster (0 = the ground, left transparent).
export const WHITE = 1;
export const MUTED = 2;
export const RAIL = 3;
export const COBALT = 4;
export const DEEP = 5;
export const GROUND = 6; // the ground, OPAQUE: a digit cut out of the landing chip
export const DUSK = 7; // iron's under-face
export const FOIL = 8; // the holographic foil: its colour is `foilInk`'s, per cell
export const FOIL_DEEP = 9; // … on the metal's under-face

export const INKS: readonly string[] = [
  '#ffffff', // WHITE  (--fg)
  '#a6adb8', // MUTED  (--muted)
  '#4a5578', // RAIL   (--rail): iron, a link not lit yet
  '#4a6aff', // COBALT (--solve, the one accent)
  '#1c2566', // DEEP   (the cobalt at a quarter, kit.ts)
  '#050507', // GROUND (--bg)
  '#1f212a', // DUSK   (--surface-hover)
  '#ffffff', // FOIL   (painted per cell by `foilInk`; white where it is not)
  '#1c2566', // FOIL_DEEP
];
// An ink packed for a canvas raster seen through a Uint32Array (`raster.ts`), by its index
// above (1 is INKS' first: the raster's 0 is the ground).
export const inkAbgr = (index: number) => hexToAbgr(INKS[index - 1]);

// The under-face of a material: cobalt's deep, iron's dusk, the foil's darker self; white-hot
// metal is white through.
export const shade = (v: number) => (v === COBALT ? DEEP : v === RAIL ? DUSK : v === FOIL ? FOIL_DEEP : v);

// ── The link ──────────────────────────────────────────────────────────────────────────────
// A face-on link: a stadium WIDER than tall with a two-cell stroke round an open hole — a
// chain's links lie along it, which is also what keeps a row of them from reading as a row
// of zeros under the count. One flat ink; the deep (`D`) only where the hole's corners turn
// away, the metal's inner edge. `o` is the hole. Pixel art does not rotate: every day wears
// this one upright cut, and where the chain curves the links STEP, a whole cell at a time.
const LINK = [
  '..CCCCCCC..',
  '.CCCCCCCCC.',
  'CCDoooooDCC',
  'CCoooooooCC',
  'CCoooooooCC',
  'CCDoooooDCC',
  '.CCCCCCCCC.',
  '..CCCCCCC..',
];
// A day still to come: the same link EMPTY — its rounded corners kept whole, its long runs
// dashed — so it reads as the link it will be, never as a lens or a mesh.
const LINK_GHOST = [
  '..CC.C.CC..',
  '.CC.....CC.',
  'CC.......CC',
  'C.........C',
  'C.........C',
  'CC.......CC',
  '.CC.....CC.',
  '..CC.C.CC..',
];
// A day missed: the link left OPEN — iron, its stroke cut through at the top right. The chain
// broke there; no edge-on link threads it.
const LINK_CUT: readonly (readonly [number, number])[] = [
  [7, 0],
  [8, 0],
  [8, 1],
  [9, 1],
];
export const LINK_W = 11;
export const LINK_H = 8;
// Centre to centre along the chain: a link and a gap the edge-on link spans — three cells
// where the screen has the room, two on the narrowest phones.
export const LINK_PITCH = 14;
export const LINK_PITCH_TIGHT = 13;
// The edge-on link shows this far into each hole from its link's centre (cells).
export const BAR_REACH = 2;

// A day's link: its centre (cells — on a cell's middle across, a cell's edge down, so the
// sprite lands on whole cells).
export interface LinkPlace {
  x: number;
  y: number;
}

// A day's link as cells: where each lands, whether it is metal (and on which face) or the
// hole, where in the sprite it sits — and whether the cell is one of the link's empty GHOST
// (a day to come) and one its CUT leaves open (a day missed).
export interface SpriteCell {
  x: number;
  y: number;
  lx: number;
  ly: number;
  part: 'metal' | 'deep' | 'hole';
  ghost: boolean;
  cut: boolean;
}
export function linkCellsAt(link: LinkPlace): SpriteCell[] {
  const x0 = Math.round(link.x - LINK_W / 2);
  const y0 = Math.round(link.y - LINK_H / 2);
  const out: SpriteCell[] = [];
  for (let ly = 0; ly < LINK_H; ly += 1) {
    for (let lx = 0; lx < LINK_W; lx += 1) {
      const ch = LINK[ly][lx];
      if (ch === '.') continue;
      out.push({
        x: x0 + lx,
        y: y0 + ly,
        lx,
        ly,
        part: ch === 'o' ? 'hole' : ch === 'D' ? 'deep' : 'metal',
        ghost: LINK_GHOST[ly][lx] === 'C',
        cut: LINK_CUT.some(([cx, cy]) => cx === lx && cy === ly),
      });
    }
  }
  return out;
}

// ── The foil ──────────────────────────────────────────────────────────────────────────────
// The holographic foil (`foil.ts`) as a CELL material, in the raster's own cells: the app's
// inks as one pastel loop drifting along each link's diagonal `u`, masked by a noise shimmer,
// with a white sheen passing. ABGR, for the dialog's ImageData. The metal's under-face is the
// same foil, darkened toward the DEEP.
const LINK_HOLO_PASTEL = 0.12;
const LINK_HOLO_DRIFT = 0.16;
const LINK_SHEEN_PERIOD_S = 3.2;
const LINK_SHEEN_WIDTH = 0.3;
const wrap = (k: number) => k - Math.floor(k);
export function foilInk(
  x: number,
  y: number,
  u: number,
  phase: number,
  seconds: number,
  seed: number,
  deep: boolean,
): number {
  const nInks = HOLO_INKS.length;
  const k = wrap(u * 1.15 - seconds * LINK_HOLO_DRIFT + seed * 0.37 + phase) * nInks;
  const i = Math.floor(k);
  const f = k - i;
  const a = HOLO_INKS[i];
  const b = HOLO_INKS[(i + 1) % nInks];
  const n = noise3(x / 3.2 - seconds * 0.6 + seed * 101.7, y / 4.1 + seed * 53.1, T0 + seconds * 0.35);
  const shimmer = 0.45 + 0.55 * clamp01(0.5 + (n - 0.5) * 2.4);
  const pass = wrap(seconds / LINK_SHEEN_PERIOD_S + seed * 0.61 - phase * 0.7);
  const centre = -LINK_SHEEN_WIDTH + pass * (1 + 2 * LINK_SHEEN_WIDTH);
  const band = Math.max(0, 1 - Math.abs(u - centre) / LINK_SHEEN_WIDTH);
  const rgb = [0, 1, 2].map((j) => {
    const ink = a[j] + (b[j] - a[j]) * f;
    const pastel = ink + (255 - ink) * LINK_HOLO_PASTEL;
    let c = 255 + (pastel - 255) * shimmer;
    c += (255 - c) * 0.7 * band;
    if (deep) c = c * 0.45 + [28, 37, 102][j] * 0.55;
    return Math.round(c);
  });
  return ((255 << 24) | (rgb[2] << 16) | (rgb[1] << 8) | rgb[0]) >>> 0;
}

// A cell writer: (x, y) in cells, an ink index; off the raster it draws nothing.
export type Put = (x: number, y: number, v: number) => void;

// ── The glitter's star ────────────────────────────────────────────────────────────────────
// A four-point star in whole cells and solid inks — pixel art does not fade, it steps: a
// white cross, the long cross at its height (its tips the cobalt), the cross, gone. Never a
// lone cell: a single pixel in the air reads as a dead one. The foil's colours stay on the
// foil. `life` is the foil's sparkle curve (`sparkleAt`).
const STAR_MIN_LIFE = 0.35;
export function star(put: Put, x: number, y: number, life: number, long: boolean) {
  if (life <= STAR_MIN_LIFE) return;
  const arm = life > 0.8 && long ? 2 : 1;
  for (let a = 1; a <= arm; a += 1) {
    const v = a === 2 ? COBALT : WHITE;
    put(x - a, y, v);
    put(x + a, y, v);
    put(x, y - a, v);
    put(x, y + a, v);
  }
  put(x, y, WHITE);
}

// ── The crown's flame ─────────────────────────────────────────────────────────────────────
// Where it burns: its foot (cells), its height and half-width at rest.
export interface Crown {
  x: number;
  y: number;
  h: number;
  w: number;
}

// The flame: a teardrop of cells whose edge is broken by value noise scrolling UP (fire
// rises), its tip swaying and throwing off tongues; inside it the solve's cobalt, a heart
// of white dithered over the cobalt, a small white core at the foot, and a dithered DEEP
// halo for its light (light is drawn by dither, never a glow). Before the crown catches it
// is a pilot spark; it catches in whole steps, never scaled.
export function flame(put: Put, crown: Crown, t: number, tl: Timeline, seconds: number, closes: boolean) {
  const baseX = crown.x;
  const baseY = crown.y + 1;
  const fullH = crown.h;
  const halfW = crown.w;
  const grow =
    t < tl.crown ? 0 : Math.ceil(clamp01(backOut(at(t, tl.crown, CROWN_MS))) * CROWN_STEPS) / CROWN_STEPS;
  // The flame flickers at its own stepped rate, slower than the frames.
  const s = Math.floor(seconds / 0.09) * 0.09;

  if (t < tl.orbitIn + WEEK_SWEEP_MS * 0.6 + WRAP_SWEEP_MS) return; // the orbit has not met at the top yet
  if (grow === 0) {
    // THE PILOT: a spark breathing at the foot.
    const flick = noise3(3.1, s * 6, T0) > 0.5;
    put(baseX - 1, baseY - 1, flick ? WHITE : COBALT);
    put(baseX, baseY - 1, COBALT);
    put(baseX - 1, baseY - 2, COBALT);
    put(baseX, baseY - 2, flick ? COBALT : DEEP);
    put(baseX - 1, baseY - 3, flick ? DEEP : COBALT);
    return;
  }

  // The FLARE as the light reaches it, in the crown's own whole steps (tenths of its height).
  const flare =
    t >= tl.flare
      ? Math.round((closes ? FLARE : RELAY_FLARE) * (1 - at(t, tl.flare, closes ? FLARE_MS : RELAY_FLARE_MS)) * 10) / 10
      : 0;
  const h = fullH * Math.max(0.2, grow) * (1 + flare);
  const w = halfW * (0.6 + 0.4 * Math.min(1, grow));
  // ONE flame shape at three sizes, nested from the same foot, each with its own noise, so
  // the layers lick independently instead of ringing like a target.
  const inside = (x: number, y: number, hs: number, ws: number, kk: number) => {
    const v = (baseY - y) / (h * hs);
    if (v < -0.06 || v > 1.25) return false;
    const foot = 0.28;
    const bulb =
      v < foot ? Math.sqrt(clamp01(1 - ((foot - v) / (foot + 0.1)) ** 2)) : clamp01(1 - (v - foot) / (1 - foot)) ** 1.3;
    const sway = 0.2 * v * v * Math.sin(s * 4.6 + v * 2.2 + kk) + 0.16 * v * (noise3(1.7 + kk, s * 2.1, T0) - 0.5);
    const nz = noise3((x - baseX) * 0.36 + kk * 13, (y + s * 30) * 0.3, T0 + s * 0.9 + kk);
    const half = w * ws * bulb * (0.62 + 0.76 * nz);
    return Math.abs((x + 0.5 - baseX) / (w * ws) - sway) * w * ws < half;
  };
  const top = Math.round(baseY - h * 1.3) - 2;
  for (let y = top; y <= baseY + 2; y += 1) {
    for (let x = Math.round(baseX - w * 2); x <= Math.round(baseX + w * 2); x += 1) {
      if (inside(x, y, 0.38, 0.42, 7.1)) put(x, y, WHITE);
      else if (inside(x, y, 0.68, 0.68, 3.3)) put(x, y, th(x, y) < 0.5 ? WHITE : COBALT);
      else if (inside(x, y, 1, 1, 0)) put(x, y, COBALT);
      else if (th(x, y) < 0.42 && inside(x, y, 1.12, 1.55, 0.6)) put(x, y, DEEP);
    }
  }
  // EMBERS lifting off the tip, each on its own clock.
  if (grow >= 1) {
    for (let e = 0; e < 4; e += 1) {
      const period = 1.1 + 0.6 * hash3(e, 1, 31);
      const local = seconds + hash3(e, 2, 31) * period;
      const cycle = Math.floor(local / period);
      const age = (local - cycle * period) / period;
      if (age > 0.7) continue;
      const rise = age / 0.7;
      const ex = baseX + (hash3(e, cycle, 32) - 0.5) * w * 1.4 + Math.sin(seconds * 3 + e) * 1.5 * rise;
      const ey = baseY - h * (0.55 + 0.3 * hash3(e, cycle, 33)) - rise * h * 0.5;
      put(ex, ey, rise < 0.35 ? WHITE : rise < 0.7 ? COBALT : DEEP);
    }
  }
}
