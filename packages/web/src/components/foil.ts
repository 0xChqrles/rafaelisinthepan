import { BAYER_8 } from '@whippin/shared';
import { T0, hash3, noise3 } from './noise';

// THE HOLOGRAPHIC FOIL — the app's one shiny MATERIAL (user-decided 2026-09-22, the activated
// hole: "something more holographic like a pokemon card… make something really beautiful this
// time"): a white surface catching light it is not under. Four layers, every frame:
//   1. THE SPECTRUM: a pastel band of THE APP'S OWN INKS — the hole's cyan, the solve
//      cobalt, the heat ramp's orchid and coral, lifted toward white so ink stays legible on
//      every one (user-asked 2026-09-22, "a more whippin AI friendly palette") — running
//      diagonally through the surface and drifting along it: the angle-dependent colour of a
//      foil, with time standing in for the tilt;
//   2. THE SHIMMER: the spectrum is MASKED by one octave of value noise (`noise.ts`) scrolled
//      through the surface, so the rainbow does not slide flat but pools and swirls, a
//      "cosmos" foil rather than a printed gradient; a bitmap one pixel a cell, drawn up
//      through bilinear smoothing;
//   3. THE SHEEN: one soft white specular band sweeping the diagonal on its own, slower
//      period — the flash a card gives as it turns;
//   4. THE SPARKLES: pixel-art four-point stars (a plus of cells, a few of them longer-armed)
//      at hashed cells — the glitter in the foil. EACH ON ITS OWN CLOCK (user-asked
//      2026-09-22: "each star be independant… the stars should stay a bit before fading
//      out… it's supposed to be chill"): a cell's clock is offset by its own hash; a star
//      rises in, HOLDS, then fades out slowly — few at a time.
// Its consumers: the charge meter's activated hole and the wheel's foil rows (`MeterCanvas`,
// through `paintFoil`); the result's COUNT (`MeterCanvas`'s shaped meter, through
// `paintCountFoil` and `paintCountGlints`, below — the same four layers DITHERED, at a size
// many times a chip's); and the streak celebration's forged link, which wears the same inks
// and sparkle curve as a material of its raster's cells (`streak/sprites.ts` `foilInk`). Each
// surface steps it at its own pace and passes its own `seed` — the same material, never the
// same picture.

const FOIL_CELL_PX = 2;

// The spectrum: the app's inks as one closed loop — cyan (`--hole`), cobalt (`--solve`),
// orchid and coral (the heat ramp's strange stops) and back the way it came, so the band
// has no seam — each lifted HOLO_PASTEL of the way to white (the ink has to read on every
// one); HOLO_CYCLES loops across the surface's diagonal, drifting HOLO_DRIFT of a surface a
// second, at HOLO_ALPHA over the white at its strongest.
export const HOLO_INKS: readonly [number, number, number][] = [
  [0, 229, 255], // #00e5ff cyan — the hole
  [74, 106, 255], // #4a6aff cobalt — the solve
  [242, 97, 226], // #f261e2 orchid
  [255, 95, 120], // #ff5f78 coral
  [242, 97, 226],
  [74, 106, 255],
];
const HOLO_PASTEL = 0.42;
const HOLO_CYCLES = 1.1;
const HOLO_DRIFT = 0.09;
const HOLO_ALPHA = 0.74;

// The fractional part: where along the diagonal (0 at the top-left, 1 at the bottom-right) a
// band's position `k` (any real) falls, wrapped.
const wrap = (k: number) => k - Math.floor(k);

// The loop's colour at `k` in [0, 1): a straight mix between the two inks either side,
// lifted toward white.
function holoInk(k: number): string {
  const n = HOLO_INKS.length;
  const at = wrap(k) * n;
  const i = Math.floor(at);
  const t = at - i;
  const a = HOLO_INKS[i];
  const b = HOLO_INKS[(i + 1) % n];
  const c = a.map((v, j) => {
    const mixed = v + (b[j] - v) * t;
    return Math.round(mixed + (255 - mixed) * HOLO_PASTEL);
  });
  return `rgb(${c[0]} ${c[1]} ${c[2]})`;
}

// The shimmer: a lattice unit is SHIMMER_CELLS cells (a chip is ~15 cells tall at the
// sentence's size), sliding SHIMMER_DRIFT units a second and evolving SHIMMER_EVOLVE a second
// in the third dimension — never a loop; the mask spans SHIMMER_FLOOR to 1 of the spectrum's
// alpha, so the rainbow is never absent, only pooled.
const SHIMMER_CELLS_X = 11;
const SHIMMER_CELLS_Y = 6;
const SHIMMER_DRIFT = 0.35;
const SHIMMER_EVOLVE = 0.2;
const SHIMMER_FLOOR = 0.3;
// The sheen: a white band SHEEN_WIDTH of the diagonal wide at SHEEN_ALPHA, once every
// SHEEN_PERIOD_S along it.
const SHEEN_WIDTH = 0.28;
const SHEEN_ALPHA = 0.5;
const SHEEN_PERIOD_S = 4.5;
// The sparkles: every cell runs its own SPARKLE_PERIOD_S cycle, offset by its hash; in a cycle
// it is a star with probability `sparkleShare` (SPARKLE_SHARE by default). A star's life: it
// rises over SPARKLE_RISE_S, holds for SPARKLE_HOLD_S, fades over SPARKLE_FADE_S — a slow
// breath, not a flash; SPARKLE_LONG of the stars have two-cell arms. About five stars stand on
// a sentence chip at any moment.
const SPARKLE_PERIOD_S = 2.4;
const SPARKLE_SHARE = 0.01;
const SPARKLE_RISE_S = 0.16;
const SPARKLE_HOLD_S = 0.3;
const SPARKLE_FADE_S = 0.55;
const SPARKLE_LIFE_S = SPARKLE_RISE_S + SPARKLE_HOLD_S + SPARKLE_FADE_S;
const SPARKLE_LONG = 0.25;

// Where a star is in its life, 0–1: eased in, held, eased out.
export function sparkleAt(age: number): number {
  if (age < SPARKLE_RISE_S) {
    const k = age / SPARKLE_RISE_S;
    return k * k * (3 - 2 * k);
  }
  if (age < SPARKLE_RISE_S + SPARKLE_HOLD_S) return 1;
  const k = 1 - (age - SPARKLE_RISE_S - SPARKLE_HOLD_S) / SPARKLE_FADE_S;
  return k <= 0 ? 0 : k * k * k;
}

// The shimmer at a cell, 0–1: the noise, read at this seed's own place in the field. `pools`
// scales the lattice (a larger surface's pools span more cells); `floor` is the least of it.
function shimmerAt(
  cx: number,
  cy: number,
  seconds: number,
  seed: number,
  pools = 1,
  floor = SHIMMER_FLOOR,
): number {
  const n = noise3(
    cx / (SHIMMER_CELLS_X * pools) - seconds * SHIMMER_DRIFT + seed * 101.7,
    cy / (SHIMMER_CELLS_Y * pools) + seed * 53.1,
    T0 + seconds * SHIMMER_EVOLVE,
  );
  // One octave of value noise lives mostly in 0.3–0.7: stretched about the half so the pools
  // reach full and the troughs the floor.
  const v = Math.min(1, Math.max(0, 0.5 + (n - 0.5) * 2.4));
  return floor + (1 - floor) * v;
}

// A surface's scratch: the shimmer's one-pixel-a-cell bitmap, reused frame to frame.
export interface FoilScratch {
  bitmap?: HTMLCanvasElement;
}

// Paint the foil's four layers over `ctx`'s (w × h) CSS-pixel box, which must be CLEARED (or
// white-backed by the surface) — layer 2 masks whatever is already there. `sparkleShare`
// tunes the glitter's density for a surface much smaller or larger than a chip.
export function paintFoil(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  seconds: number,
  seed: number,
  scratch: FoilScratch,
  sparkleShare = SPARKLE_SHARE,
): void {
  const cols = Math.ceil(w / FOIL_CELL_PX);
  const rows = Math.ceil(h / FOIL_CELL_PX);
  // The diagonal the band and the sheen run along: top-left to bottom-right, leaning with
  // the surface's width so a long word still shows the whole spectrum.
  const dx = w;
  const dy = h * 0.9;

  // 1. THE SPECTRUM, drifting along the diagonal.
  const spectrum = ctx.createLinearGradient(0, 0, dx, dy);
  const shift = wrap(seconds * HOLO_DRIFT + seed * 0.37);
  const stops = 18;
  for (let i = 0; i <= stops; i += 1) {
    const at = i / stops;
    spectrum.addColorStop(at, holoInk((at - shift) * HOLO_CYCLES));
  }
  ctx.fillStyle = spectrum;
  ctx.fillRect(0, 0, w, h);

  // 2. THE SHIMMER: keep the spectrum where the field pools, thin it where it troughs — the
  // mask is a bitmap one pixel a cell drawn up through bilinear smoothing.
  const off = (scratch.bitmap ??= document.createElement('canvas'));
  if (off.width !== cols || off.height !== rows) {
    off.width = cols;
    off.height = rows;
  }
  const octx = off.getContext('2d');
  if (!octx) return;
  const img = octx.createImageData(cols, rows);
  const d = img.data;
  for (let cy = 0; cy < rows; cy += 1) {
    for (let cx = 0; cx < cols; cx += 1) {
      const i = (cy * cols + cx) * 4;
      d[i + 3] = Math.round(255 * HOLO_ALPHA * shimmerAt(cx, cy, seconds, seed));
    }
  }
  octx.putImageData(img, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(off, 0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';

  // 3. THE SHEEN: a soft white band passing along the diagonal.
  const pass = wrap(seconds / SHEEN_PERIOD_S + seed * 0.61);
  const centre = -SHEEN_WIDTH + pass * (1 + 2 * SHEEN_WIDTH);
  const sheen = ctx.createLinearGradient(0, 0, dx, dy);
  const edge = (k: number) => Math.min(1, Math.max(0, k));
  sheen.addColorStop(edge(centre - SHEEN_WIDTH), 'rgba(255,255,255,0)');
  sheen.addColorStop(edge(centre), `rgba(255,255,255,${SHEEN_ALPHA})`);
  sheen.addColorStop(edge(centre + SHEEN_WIDTH), 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, w, h);

  // 4. THE SPARKLES: four-point stars at hashed cells, each on its own clock.
  for (let cy = 1; cy < rows - 1; cy += 1) {
    for (let cx = 1; cx < cols - 1; cx += 1) {
      // This cell's clock: its own offset into the period, so no two stars share a beat.
      const local = seconds + hash3(cx, cy, seed * 31 + 7) * SPARKLE_PERIOD_S;
      const cycle = Math.floor(local / SPARKLE_PERIOD_S);
      const age = local - cycle * SPARKLE_PERIOD_S;
      if (age >= SPARKLE_LIFE_S) continue;
      if (hash3(cx + seed * 977, cy, cycle) >= sparkleShare) continue;
      // In, held, out — the arms go with the alpha, the centre holds brighter and leaves last.
      const fade = sparkleAt(age);
      const long = hash3(cx, cy + 5, cycle) < SPARKLE_LONG;
      const arm = (long ? 2 : 1) * FOIL_CELL_PX;
      const x = cx * FOIL_CELL_PX;
      const y = cy * FOIL_CELL_PX;
      ctx.fillStyle = `rgba(255,255,255,${0.85 * fade})`;
      ctx.fillRect(x - arm, y, 2 * arm + FOIL_CELL_PX, FOIL_CELL_PX);
      ctx.fillRect(x, y - arm, FOIL_CELL_PX, 2 * arm + FOIL_CELL_PX);
      ctx.fillStyle = `rgba(255,255,255,${Math.min(1, 1.6 * fade)})`;
      ctx.fillRect(x, y, FOIL_CELL_PX, FOIL_CELL_PX);
    }
  }
}

// ── THE COUNT'S FOIL ─────────────────────────────────────────────────────────────────────
// The result's count (`SolvedCard`) wears the material as its PRIZE: a field many times a
// chip's height, cut to the digits' own pixels (20px each on a phone). Blended, the foil
// reads there as an airbrushed gradient in a pixel stencil, so it is DRAWN THE PIXEL ART'S
// WAY — the same four layers on the house's 2px cell, every colour ORDERED-DITHERED (shared
// `bayer.ts`) instead of blended: each cell takes ONE of a few inks by its Bayer threshold —
// one of the two inks of the loop either side of its place on the diagonal, at one of
// COUNT_DITHER_LEVELS strengths over the white (the shimmer's pools), or white under the
// sheen. Hard cells in a few inks, like the run's heat under it.
//
// ONE SLAB: it shows a WINDOW of COUNT_CYCLES of the loop across the whole number and drifts
// by sliding that window along the closed loop itself — never a seam, never a sticker per
// digit in its own colour family — turning slower (COUNT_DRIFT), its pools COUNT_POOLS times
// larger, its inks a step deeper (less lifted, a higher floor) so the spectrum reads across a
// big white shape, its sheen a narrower band passing brighter. The sheen's FIRST pass is timed
// to the foil: it crosses the middle COUNT_FLASH_S after the foil began, as the charge
// dissolves — the number catching the light the moment it turns. The glitter is sparser
// (COUNT_SPARKLE of a chip's share) and STEPS: a star's centre, then its arms, then a long
// star's second cells, and back.
export const COUNT_FOIL_CELL_PX = 2;
const COUNT_DITHER_LEVELS = 4;
const COUNT_CYCLES = 0.34;
const COUNT_DRIFT = 0.05;
const COUNT_POOLS = 3;
const COUNT_PASTEL = 0.3;
const COUNT_ALPHA = 0.86;
const COUNT_FLOOR = 0.5;
const COUNT_SHEEN_WIDTH = 0.15;
const COUNT_SHEEN_ALPHA = 0.8;
const COUNT_FLASH_S = 0.45;
const COUNT_SPARKLE = 0.22;

// The loop's ink `i`, `level` of COUNT_DITHER_LEVELS − 1 of the way from white to its full
// strength (lifted COUNT_PASTEL, at COUNT_ALPHA), as a fill — memoised: the count is drawn
// from a couple of dozen colours.
const countInks = new Map<number, string>();
function countInk(i: number, level: number): string {
  const key = i * COUNT_DITHER_LEVELS + level;
  let hit = countInks.get(key);
  if (!hit) {
    const a = (COUNT_ALPHA * level) / (COUNT_DITHER_LEVELS - 1);
    const c = HOLO_INKS[i].map((v) => {
      const lifted = v + (255 - v) * COUNT_PASTEL;
      return Math.round(255 + (lifted - 255) * a);
    });
    hit = `rgb(${c[0]} ${c[1]} ${c[2]})`;
    countInks.set(key, hit);
  }
  return hit;
}

// Paint the count's foil over `ctx`'s (w × h) CSS-pixel box, only where `inside` says the
// count has ink. `since` is when the foil began on this surface, in seconds of the same clock
// (0 for one born in the foil): the sheen's first pass is timed off it.
export function paintCountFoil(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  seconds: number,
  seed: number,
  since: number,
  inside: (x: number, y: number) => boolean,
): void {
  const grain = COUNT_FOIL_CELL_PX;
  const dx = w;
  const dy = h * 0.9;
  const diag = dx * dx + dy * dy;
  const n = HOLO_INKS.length;
  const shift = wrap(seconds * COUNT_DRIFT + seed * 0.37);
  const pass = wrap((seconds - since - COUNT_FLASH_S) / SHEEN_PERIOD_S + 0.5);
  const centre = -COUNT_SHEEN_WIDTH + pass * (1 + 2 * COUNT_SHEEN_WIDTH);
  const cols = Math.ceil(w / grain);
  const rows = Math.ceil(h / grain);
  // One path per ink: a frame is a handful of fills, each a union of cells.
  const batches = new Map<string, Path2D>();
  const put = (fill: string, x: number, y: number) => {
    let path = batches.get(fill);
    if (!path) {
      path = new Path2D();
      batches.set(fill, path);
    }
    path.rect(x, y, grain, grain);
  };
  // The shimmer's lattice is read on the chip's own 2px cells, whatever this grain.
  const shimmerScale = grain / FOIL_CELL_PX;
  for (let cy = 0; cy < rows; cy += 1) {
    for (let cx = 0; cx < cols; cx += 1) {
      const x = cx * grain;
      const y = cy * grain;
      if (!inside(x + grain / 2, y + grain / 2)) continue;
      const u = (BAYER_8[(cy & 7) * 8 + (cx & 7)] + 0.5) / 64;
      const t = ((x + grain / 2) * dx + (y + grain / 2) * dy) / diag;
      // Under the sheen's band: white, by its density there.
      const band = 1 - Math.abs(t - centre) / COUNT_SHEEN_WIDTH;
      if (band > 0 && band * COUNT_SHEEN_ALPHA > u) {
        put('#fff', x, y);
        continue;
      }
      // Which of the two inks either side of this place on the loop's window.
      const at = wrap(t * COUNT_CYCLES - shift) * n;
      const i0 = Math.floor(at);
      const ink = at - i0 > u ? (i0 + 1) % n : i0;
      // How strong over the white: the shimmer's pool, dithered between two levels.
      const pool = shimmerAt(cx * shimmerScale, cy * shimmerScale, seconds, seed, COUNT_POOLS, COUNT_FLOOR);
      const q = pool * (COUNT_DITHER_LEVELS - 1);
      const lo = Math.floor(q);
      const level = Math.min(COUNT_DITHER_LEVELS - 1, q - lo > 1 - u ? lo + 1 : lo);
      put(level === 0 ? '#fff' : countInk(ink, level), x, y);
    }
  }
  batches.forEach((path, fill) => {
    ctx.fillStyle = fill;
    ctx.fill(path);
  });

  // The glitter: each cell on its own clock, as the chip's, stepping its arms.
  ctx.fillStyle = '#fff';
  for (let cy = 1; cy < rows - 1; cy += 1) {
    for (let cx = 1; cx < cols - 1; cx += 1) {
      const local = seconds + hash3(cx, cy, seed * 31 + 7) * SPARKLE_PERIOD_S;
      const cycle = Math.floor(local / SPARKLE_PERIOD_S);
      const age = local - cycle * SPARKLE_PERIOD_S;
      if (age >= SPARKLE_LIFE_S) continue;
      if (hash3(cx + seed * 977, cy, cycle) >= SPARKLE_SHARE * COUNT_SPARKLE) continue;
      const x = cx * grain;
      const y = cy * grain;
      if (!inside(x + grain / 2, y + grain / 2)) continue;
      const fade = sparkleAt(age);
      if (fade < 0.2) continue;
      const long = hash3(cx, cy + 5, cycle) < SPARKLE_LONG;
      const arm = (fade < 0.55 ? 0 : long && fade > 0.9 ? 2 : 1) * grain;
      ctx.fillRect(x - arm, y, 2 * arm + grain, grain);
      ctx.fillRect(x, y - arm, grain, 2 * arm + grain);
    }
  }
}

// THE COUNT'S GLINTS, over everything and across its edge: COUNT_GLINT_SLOTS stars taking
// turns on the cap line's outer corners (`spots`, `countCells.ts` `capCorners`) — slot 0 in
// the left half, slot 1 in the right — so one stands at a time, two only while one hands over.
// Full white on COUNT_GLINT_CELL_PX cells, centred on the corner's ink; a star GROWS its arms
// in whole cells to COUNT_GLINT_ARM, holds, and draws them back in: a pixel star, not a
// crosshair. Each cycle picks its corner by hash.
export const COUNT_GLINT_CELL_PX = 4;
const COUNT_GLINT_SLOTS = 2;
const COUNT_GLINT_PERIOD_S = 3.6;
const COUNT_GLINT_RISE_S = 0.16;
const COUNT_GLINT_HOLD_S = 1.5;
const COUNT_GLINT_FADE_S = 0.32;
const COUNT_GLINT_ARM = 2;
// A still count (reduced motion) holds this instant of the clock, at which a glint stands in
// full.
export const COUNT_STILL_S = 2.9;

export function paintCountGlints(
  ctx: CanvasRenderingContext2D,
  spots: readonly (readonly [number, number])[],
  w: number,
  seconds: number,
  seed: number,
): void {
  const g = COUNT_GLINT_CELL_PX;
  const life = COUNT_GLINT_RISE_S + COUNT_GLINT_HOLD_S + COUNT_GLINT_FADE_S;
  ctx.fillStyle = '#fff';
  for (let slot = 0; slot < COUNT_GLINT_SLOTS; slot += 1) {
    const local = seconds + (slot * COUNT_GLINT_PERIOD_S) / COUNT_GLINT_SLOTS;
    const cycle = Math.floor(local / COUNT_GLINT_PERIOD_S);
    const age = local - cycle * COUNT_GLINT_PERIOD_S;
    if (age >= life) continue;
    let fade: number;
    if (age < COUNT_GLINT_RISE_S) fade = age / COUNT_GLINT_RISE_S;
    else if (age < COUNT_GLINT_RISE_S + COUNT_GLINT_HOLD_S) fade = 1;
    else fade = 1 - (age - COUNT_GLINT_RISE_S - COUNT_GLINT_HOLD_S) / COUNT_GLINT_FADE_S;
    const east = slot === 1;
    const mine = spots.filter(([sx]) => sx >= w / 2 === east);
    if (mine.length === 0) continue;
    const [x, y] = mine[Math.floor(hash3(slot + seed * 13, cycle, 57) * mine.length)];
    const arm = Math.round(fade * COUNT_GLINT_ARM) * g;
    ctx.fillRect(x - arm, y, 2 * arm + g, g);
    ctx.fillRect(x, y - arm, g, 2 * arm + g);
  }
}
