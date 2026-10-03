import { BAYER_8 } from '@whippin/shared';

// THE METER'S RAMP, as numbers (`MeterCanvas` draws it): where the fill's FRONT stands for a
// reading, how dense the ink is at a column, and when the chip is solid. Pure, so the fill's
// last frames — what the burst waits for — are pinned by a test.
//
// For a reading under 100 the front is exactly the reading's share of the width and the
// density falls from solid to nothing over `ramp` columns BEHIND it, so a chip short of 100
// always ends in white (user-reported 2026-09-22: a front past the edge read as full at 95,
// "some users think that there's a bug"). A FULL reading's front stands a whole ramp PAST
// the edge, and a travel moves the FRONT, not the reading: the trailing ramp sweeps out of
// the chip and its last cells ink frame by frame, so the chip turns solid as part of the
// fill — never a one-frame snap of its last ramp under the burst (user-reported 2026-10-03:
// "the burst animation is played BEFORE the word gets 100% filled").

export function meterFront(reading: number, cols: number, ramp: number): number {
  return reading >= 100 ? cols + ramp : (reading / 100) * cols;
}

// The ink's density at column `cx` (0 = none, 1 = every cell).
export function rampDensity(front: number, cx: number, ramp: number): number {
  return Math.min(1, (front - cx) / ramp);
}

// Whether the cell (cx, cy) is inked at that density: its Bayer threshold is under it.
export function cellInked(density: number, cx: number, cy: number): boolean {
  return density > 0 && BAYER_8[(cy & 7) * 8 + (cx & 7)] < density * 64;
}

// Whether every cell of a `cols` × `rows` chip is inked — the painter's own rule, asked of
// the columns the ramp still thins (the matrix repeats every 8 rows).
export function frontIsSolid(front: number, cols: number, rows: number, ramp: number): boolean {
  for (let cx = cols - 1; cx >= 0; cx -= 1) {
    const d = rampDensity(front, cx, ramp);
    if (d >= 1) return true;
    for (let cy = 0; cy < Math.min(rows, 8); cy += 1) if (!cellInked(d, cx, cy)) return false;
  }
  return true;
}

// The front a travel from one reading to another has reached `eased` of the way.
export function travelFront(from: number, to: number, eased: number, cols: number, ramp: number): number {
  const a = meterFront(from, cols, ramp);
  return a + (meterFront(to, cols, ramp) - a) * eased;
}

// How far along its travel the fill is at `k` of its duration: eased out, fast then settling.
export function easeOut(k: number): number {
  return 1 - (1 - k) ** 3;
}
