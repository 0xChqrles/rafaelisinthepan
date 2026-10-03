import { BAYER_8 } from '@whippin/shared';
import { T0, hash3, noise3 } from './noise';

// THE HOLOGRAPHIC FOIL — the app's one shiny MATERIAL (user-decided 2026-09-22, the activated
// hole: "something more holographic like a pokemon card… make something really beautiful this
// time"): a white surface catching light it is not under, DRAWN THE PIXEL ART'S WAY (user-asked
// 2026-10-03, the count's foil on the filled words too: "reuse the effect you've created for the
// try count with the colors and the dithering, for the filled words too") — on the house's 2px
// cell, every colour ORDERED-DITHERED (shared `bayer.ts`) instead of blended: each cell takes
// ONE of a few inks by its Bayer threshold. Hard cells in a few inks, like the run's heat. Four
// layers, every frame:
//   1. THE SPECTRUM: THE APP'S OWN INKS (`HOLO_INKS` — the hole's cyan, the solve cobalt, the
//      heat ramp's orchid and coral, one seamless loop; user-asked 2026-09-22, "a more whippin
//      AI friendly palette"), ONE SLAB: a WINDOW of FOIL_CYCLES of the loop across the
//      surface's diagonal, drifting by sliding that window along the closed loop itself
//      (FOIL_DRIFT) — never a seam. A cell takes one of the two inks either side of its place;
//   2. THE SHIMMER: how strong that ink stands over the white — one of FOIL_DITHER_LEVELS —
//      is one octave of value noise (`noise.ts`) scrolled through the surface, so the colour
//      pools and swirls, a "cosmos" foil rather than a printed gradient;
//   3. THE SHEEN: a narrow white band passing along the diagonal once every SHEEN_PERIOD_S.
//      On a surface that turns to foil before the eyes its FIRST pass crosses the middle
//      FOIL_FLASH_S after the foil began, as the charge dissolves — the thing catching the
//      light the moment it turns; a chip born in the foil passes at its seed's own phase;
//   4. THE GLITTER: pixel-art four-point stars at hashed cells, EACH ON ITS OWN CLOCK
//      (user-asked 2026-09-22: "each star be independant… the stars should stay a bit before
//      fading out… it's supposed to be chill"): a cell's clock is offset by its own hash; a
//      star rises, HOLDS, then goes — STEPPING, as pixels do: its centre, then its arms, then
//      a long star's second cells, and back.
// Its consumers: the charge meter's active hole and every GIVEN word it lists — the wheel's
// rows, the words grid (`MeterCanvas`); the result's COUNT (`MeterCanvas`'s shaped meter: the
// same material cut to the digits' pixels, its glitter sparser, plus its GLINTS,
// `paintCountGlints`); and the streak celebration's forged link, which wears the same inks
// and sparkle curve as a material of its raster's cells (`streak/sprites.ts` `foilInk`). Each
// surface steps it at its own pace and passes its own `seed` — the same material, never the
// same picture.

export const HOLO_INKS: readonly [number, number, number][] = [
  [0, 229, 255], // #00e5ff cyan — the hole
  [74, 106, 255], // #4a6aff cobalt — the solve
  [242, 97, 226], // #f261e2 orchid
  [255, 95, 120], // #ff5f78 coral
  [242, 97, 226],
  [74, 106, 255],
];

const FOIL_CELL_PX = 2;
// The spectrum: FOIL_CYCLES of the loop across the diagonal, sliding FOIL_DRIFT of the loop
// a second; each ink lifted FOIL_PASTEL of the way to white, at FOIL_ALPHA over the white at
// its strongest, in FOIL_DITHER_LEVELS steps from white.
const FOIL_DITHER_LEVELS = 4;
const FOIL_CYCLES = 0.34;
const FOIL_DRIFT = 0.05;
const FOIL_PASTEL = 0.3;
const FOIL_ALPHA = 0.86;
// The shimmer: a lattice unit is SHIMMER_CELLS × FOIL_POOLS cells, sliding SHIMMER_DRIFT units
// a second and evolving SHIMMER_EVOLVE a second in the third dimension — never a loop; the
// ink's strength spans FOIL_FLOOR to 1, so the colour is never absent, only pooled.
const SHIMMER_CELLS_X = 11;
const SHIMMER_CELLS_Y = 6;
const SHIMMER_DRIFT = 0.35;
const SHIMMER_EVOLVE = 0.2;
const FOIL_POOLS = 3;
const FOIL_FLOOR = 0.5;
// The sheen: FOIL_SHEEN_WIDTH of the diagonal wide at FOIL_SHEEN_ALPHA, once every
// SHEEN_PERIOD_S.
const FOIL_SHEEN_WIDTH = 0.15;
const FOIL_SHEEN_ALPHA = 0.8;
const SHEEN_PERIOD_S = 4.5;
const FOIL_FLASH_S = 0.45;
// The glitter: every cell runs its own SPARKLE_PERIOD_S cycle, offset by its hash; in a cycle
// it is a star with probability `sparkleShare` (SPARKLE_SHARE by default: about five stars on
// a sentence chip at a moment). A star's life: it rises over SPARKLE_RISE_S, holds for
// SPARKLE_HOLD_S, goes over SPARKLE_FADE_S — a slow breath, not a flash; SPARKLE_LONG of the
// stars have two-cell arms.
const SPARKLE_PERIOD_S = 2.4;
const SPARKLE_SHARE = 0.01;
const SPARKLE_RISE_S = 0.16;
const SPARKLE_HOLD_S = 0.3;
const SPARKLE_FADE_S = 0.55;
const SPARKLE_LIFE_S = SPARKLE_RISE_S + SPARKLE_HOLD_S + SPARKLE_FADE_S;
const SPARKLE_LONG = 0.25;

// The fractional part: where along the loop or the diagonal a position `k` (any real) falls.
const wrap = (k: number) => k - Math.floor(k);

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

// The shimmer at a cell, 0–1: the noise, read at this seed's own place in the field, its
// least FOIL_FLOOR.
function shimmerAt(cx: number, cy: number, seconds: number, seed: number): number {
  const n = noise3(
    cx / (SHIMMER_CELLS_X * FOIL_POOLS) - seconds * SHIMMER_DRIFT + seed * 101.7,
    cy / (SHIMMER_CELLS_Y * FOIL_POOLS) + seed * 53.1,
    T0 + seconds * SHIMMER_EVOLVE,
  );
  // One octave of value noise lives mostly in 0.3–0.7: stretched about the half so the pools
  // reach full and the troughs the floor.
  const v = Math.min(1, Math.max(0, 0.5 + (n - 0.5) * 2.4));
  return FOIL_FLOOR + (1 - FOIL_FLOOR) * v;
}

// The loop's ink `i`, `level` of FOIL_DITHER_LEVELS − 1 of the way from white to its full
// strength, as a fill — memoised: a frame is drawn from a couple of dozen colours.
const inks = new Map<number, string>();
function foilInk(i: number, level: number): string {
  const key = i * FOIL_DITHER_LEVELS + level;
  let hit = inks.get(key);
  if (!hit) {
    const a = (FOIL_ALPHA * level) / (FOIL_DITHER_LEVELS - 1);
    const c = HOLO_INKS[i].map((v) => {
      const lifted = v + (255 - v) * FOIL_PASTEL;
      return Math.round(255 + (lifted - 255) * a);
    });
    hit = `rgb(${c[0]} ${c[1]} ${c[2]})`;
    inks.set(key, hit);
  }
  return hit;
}

// Paint the foil over `ctx`'s (w × h) CSS-pixel box, only where `inside` says the surface is
// (the whole box when omitted). `since` is when the foil began on this surface, in seconds of
// the same clock, or null for one born in it: the sheen's pass is timed off it.
// `sparkleShare` tunes the glitter for a surface much larger than a chip.
export function paintFoil(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  seconds: number,
  seed: number,
  since: number | null,
  inside: ((x: number, y: number) => boolean) | null = null,
  sparkleShare = SPARKLE_SHARE,
): void {
  const grain = FOIL_CELL_PX;
  const dx = w;
  const dy = h * 0.9;
  const diag = dx * dx + dy * dy;
  const n = HOLO_INKS.length;
  const shift = wrap(seconds * FOIL_DRIFT + seed * 0.37);
  const pass = wrap(
    since === null ? seconds / SHEEN_PERIOD_S + seed * 0.61 : (seconds - since - FOIL_FLASH_S) / SHEEN_PERIOD_S + 0.5,
  );
  const centre = -FOIL_SHEEN_WIDTH + pass * (1 + 2 * FOIL_SHEEN_WIDTH);
  const cols = Math.ceil(w / grain);
  const rows = Math.ceil(h / grain);
  const within = (x: number, y: number) => inside === null || inside(x + grain / 2, y + grain / 2);
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
  for (let cy = 0; cy < rows; cy += 1) {
    for (let cx = 0; cx < cols; cx += 1) {
      const x = cx * grain;
      const y = cy * grain;
      if (!within(x, y)) continue;
      const u = (BAYER_8[(cy & 7) * 8 + (cx & 7)] + 0.5) / 64;
      const t = ((x + grain / 2) * dx + (y + grain / 2) * dy) / diag;
      // Under the sheen's band: white, by its density there.
      const band = 1 - Math.abs(t - centre) / FOIL_SHEEN_WIDTH;
      if (band > 0 && band * FOIL_SHEEN_ALPHA > u) {
        put('#fff', x, y);
        continue;
      }
      // Which of the two inks either side of this place on the loop's window.
      const at = wrap(t * FOIL_CYCLES - shift) * n;
      const i0 = Math.floor(at);
      const ink = at - i0 > u ? (i0 + 1) % n : i0;
      // How strong over the white: the shimmer's pool, dithered between two levels.
      const q = shimmerAt(cx, cy, seconds, seed) * (FOIL_DITHER_LEVELS - 1);
      const lo = Math.floor(q);
      const level = Math.min(FOIL_DITHER_LEVELS - 1, q - lo > 1 - u ? lo + 1 : lo);
      put(level === 0 ? '#fff' : foilInk(ink, level), x, y);
    }
  }
  batches.forEach((path, fill) => {
    ctx.fillStyle = fill;
    ctx.fill(path);
  });

  // The glitter: each cell on its own clock, stepping its arms.
  ctx.fillStyle = '#fff';
  for (let cy = 1; cy < rows - 1; cy += 1) {
    for (let cx = 1; cx < cols - 1; cx += 1) {
      const local = seconds + hash3(cx, cy, seed * 31 + 7) * SPARKLE_PERIOD_S;
      const cycle = Math.floor(local / SPARKLE_PERIOD_S);
      const age = local - cycle * SPARKLE_PERIOD_S;
      if (age >= SPARKLE_LIFE_S) continue;
      if (hash3(cx + seed * 977, cy, cycle) >= sparkleShare) continue;
      const x = cx * grain;
      const y = cy * grain;
      if (!within(x, y)) continue;
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
// crosshair. Each cycle picks its corner by hash. The count's glitter is sparser than a chip's
// (COUNT_SPARKLE of its share): its field is many times a chip's.
export const COUNT_SPARKLE = SPARKLE_SHARE * 0.22;
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
