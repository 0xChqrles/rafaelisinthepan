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
// through `paintFoil`), and the streak celebration's forged link, which wears the same inks
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

// The shimmer at a cell, 0–1: the noise, read at this seed's own place in the field.
function shimmerAt(cx: number, cy: number, seconds: number, seed: number): number {
  const n = noise3(
    cx / SHIMMER_CELLS_X - seconds * SHIMMER_DRIFT + seed * 101.7,
    cy / SHIMMER_CELLS_Y + seed * 53.1,
    T0 + seconds * SHIMMER_EVOLVE,
  );
  // One octave of value noise lives mostly in 0.3–0.7: stretched about the half so the pools
  // reach full and the troughs the floor.
  const v = Math.min(1, Math.max(0, 0.5 + (n - 0.5) * 2.4));
  return SHIMMER_FLOOR + (1 - SHIMMER_FLOOR) * v;
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
