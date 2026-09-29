// THE ORDERED DITHER'S MATRIX — Bayer 8×8, 64 levels: the app's one way of turning a density
// into pixels (the charge meter's fill and sea, the tutorial's level art). A cell is inked
// when its threshold is under the density wanted there, so a density ramp lights cells one by
// one in threshold order — the pixel art's own gradient.
// prettier-ignore
export const BAYER_8: readonly number[] = [
   0, 32,  8, 40,  2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44,  4, 36, 14, 46,  6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
   3, 35, 11, 43,  1, 33,  9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47,  7, 39, 13, 45,  5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];

// The threshold of cell (x, y), in (0, 1): ink it when the density there is above.
export function bayerThreshold(x: number, y: number): number {
  return (BAYER_8[((y & 7) << 3) | (x & 7)] + 0.5) / 64;
}
