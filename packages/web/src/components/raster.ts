// A canvas raster's pixel, as its ImageData holds it seen through a Uint32Array: ABGR, opaque —
// one packing for every scene drawn that way (the streak's orbit, the podium, the tutorial's
// art).
export function abgr(r: number, g: number, b: number): number {
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

// A `#rrggbb` ink.
export function hexToAbgr(hex: string): number {
  const v = parseInt(hex.slice(1), 16);
  return abgr((v >> 16) & 255, (v >> 8) & 255, v & 255);
}

// An `rgb(r, g, b)` ink, as `heat.ts` writes a colour.
export function rgbToAbgr(value: string): number {
  const [r, g, b] = value.match(/\d+/g)?.map(Number) ?? [0, 0, 0];
  return abgr(r, g, b);
}
