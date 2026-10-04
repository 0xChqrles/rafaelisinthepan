import {
  COUNT_GLINT_CELL_PX,
  FOIL_CELL_PX,
  FOIL_WHITE,
  SPARKLE_SHARE,
  countGlints,
  foilCells,
  foilGlitter,
  foilInkRgb,
} from '@whippin/shared';

// THE HOLOGRAPHIC FOIL ON A CANVAS: the material itself — its inks, its spectrum, shimmer,
// sheen and glitter, the count's glints — is shared (`@whippin/shared` `foil.ts`), ONE spelling
// for the screen and the share card. This only paints it: on the house's 2px cell, every frame
// of a surface that wears it — the charge meter's active hole and every GIVEN word it lists
// (`MeterCanvas`), the result's COUNT (`MeterCanvas`'s shaped meter, plus `paintCountGlints`).
// Each surface steps it at its own pace and passes its own `seed`.

// An ink's fill — memoised: a frame is drawn from a couple of dozen colours.
const fills = new Map<number, string>();
function fillOf(ink: number): string {
  if (ink === FOIL_WHITE) return '#fff';
  let hit = fills.get(ink);
  if (!hit) {
    const [r, g, b] = foilInkRgb(ink);
    hit = `rgb(${r} ${g} ${b})`;
    fills.set(ink, hit);
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
  // One path per ink: a frame is a handful of fills, each a union of cells.
  const batches = new Map<string, Path2D>();
  foilCells(w, h, seconds, seed, since, inside, grain, (ink, x, y) => {
    const fill = fillOf(ink);
    let path = batches.get(fill);
    if (!path) {
      path = new Path2D();
      batches.set(fill, path);
    }
    path.rect(x, y, grain, grain);
  });
  batches.forEach((path, fill) => {
    ctx.fillStyle = fill;
    ctx.fill(path);
  });
  ctx.fillStyle = '#fff';
  foilGlitter(w, h, seconds, seed, inside, sparkleShare, grain, (x, y, rw, rh) => ctx.fillRect(x, y, rw, rh));
}

// The count's glints (shared `countGlints`), over everything and across its edge.
export function paintCountGlints(
  ctx: CanvasRenderingContext2D,
  spots: readonly (readonly [number, number])[],
  w: number,
  seconds: number,
  seed: number,
): void {
  ctx.fillStyle = '#fff';
  countGlints(spots, w, seconds, seed, COUNT_GLINT_CELL_PX, (x, y, rw, rh) => ctx.fillRect(x, y, rw, rh));
}
