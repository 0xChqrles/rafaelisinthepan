// One octave of VALUE NOISE in 3D (x, y, TIME) — the app's one noise, shared by the two
// churning surfaces: the returning door's mark (`AccountMark`, where it was born) and the
// activated hole's sea (`MeterCanvas`). Integer-hashed, so the field is the same on every
// device and every visit; one octave, because a 10-cell tile and a 2px-cell chip cannot
// resolve more, and gradient noise would cost more code to be indistinguishable.
//
// Start a field AWAY from the lattice origin: an integer-hashed value noise is exactly its
// own hash at (0, 0, 0), and every corner of that cell is the same one — so t=0 paints a
// degenerate frame, which is the one a still (reduced-motion) surface would hold forever.
export const T0 = 4.2;

export function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
const smooth = (t: number): number => t * t * (3 - 2 * t);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

export function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = smooth(x - xi);
  const yf = smooth(y - yi);
  const zf = smooth(z - zi);
  const at = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz);
  return mix(
    mix(mix(at(0, 0, 0), at(1, 0, 0), xf), mix(at(0, 1, 0), at(1, 1, 0), xf), yf),
    mix(mix(at(0, 0, 1), at(1, 0, 1), xf), mix(at(0, 1, 1), at(1, 1, 1), xf), yf),
    zf,
  );
}
