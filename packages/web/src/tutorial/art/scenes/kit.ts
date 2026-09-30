import { bayerThreshold as th } from '../../../components/bayer';
import { hash3 } from '../../../components/noise';

export { th };

// THE LEVELS' ILLUSTRATIONS (2026-09-29): one small animated picture per level, drawn in the
// game's own pixel grammar — an ORDERED DITHER (the charge meter's Bayer 8×8) of the app's
// inks on the flat near-black ground — so the tutorial's list looks like the game it explains
// and not like stock art. Each scene says its level in one image:
//   game       a page of sentence set as bars, three held words, one charging its meter
//   distance   a cloud of words turning in space, one neighbourhood lit and joined
//   meanings   one bright word pulled between two clouds of meaning
//   attention  a row of tokens, the focus listening back along weighted arcs
//   judge      the round-robin: a matrix of duels settling into the heat ramp
//
// A scene draws INK INDICES into a raster of cells (0 = the ground, left transparent); the
// canvas (`LevelArt`) turns them into pixels. A scene is built for one raster size and draws
// any time `t` (seconds) — no state between frames, so a frame is the same on every device.

export interface Raster {
  cols: number;
  rows: number;
  ink: Uint8Array;
}

export interface Scene {
  // The inks, index 1…n (index 0 is the ground).
  inks: readonly string[];
  draw(r: Raster, t: number): void;
}

// A scene is built for one raster and one STAGE: the part of the raster it composes in. The
// rest (a card's foot, under its title) is left to the fade `LevelArt` dithers the art out
// with, so a scene centres itself on the stage, never on the whole raster.
export interface Stage {
  w: number;
  h: number;
}
export type SceneMaker = (cols: number, rows: number, stage: Stage) => Scene;

// The palette — the app's tokens and the heat ramp's stops (shared heat.ts), nothing new.
export const WHITE = '#ffffff';
export const RAIL = '#4a5578';
export const MUTED = '#a6adb8';
export const CYAN = '#00e5ff';
export const COBALT = '#4a6aff';
export const DEEP = '#1c2566'; // the cobalt at a quarter, for halos
export const ORCHID = '#f261e2';
export const CORAL = '#ff5f78';
export const AMBER = '#ffb01e';
export const RED = '#ff3d2e';

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smooth = (v: number) => {
  const k = clamp01(v);
  return k * k * (3 - 2 * k);
};

export function put(r: Raster, x: number, y: number, ink: number) {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= r.cols || yi >= r.rows) return;
  r.ink[yi * r.cols + xi] = ink;
}

export function rect(r: Raster, x0: number, y0: number, w: number, h: number, ink: number, density = 1) {
  const xa = Math.max(0, Math.round(x0));
  const ya = Math.max(0, Math.round(y0));
  const xb = Math.min(r.cols, Math.round(x0 + w));
  const yb = Math.min(r.rows, Math.round(y0 + h));
  for (let y = ya; y < yb; y += 1) {
    for (let x = xa; x < xb; x += 1) {
      if (density >= 1 || density > th(x, y)) r.ink[y * r.cols + x] = ink;
    }
  }
}

// A deterministic pseudo-random number in [0, 1) for (a, b, c).
export const rnd = (a: number, b = 0, c = 0) => hash3(a, b, c);

// The heat ramp's five inks, weird → calm, as indices into a scene's own ink list.
export const RAMP = [RED, AMBER, CORAL, ORCHID, COBALT];

