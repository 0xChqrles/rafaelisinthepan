// A player with no drawn avatar still gets a MARK (user feedback 2026-08-20 — the
// dashed empty frame read as a hole in the board): a small mirrored 10×10 creature
// generated deterministically from the publicId, in one of the real palettes, so every
// player is "assigned" a profile picture that is theirs on every surface and every
// device — with nothing stored. Display only, exactly like the pseudonym: the profile
// editor still starts blank, and a drawn avatar replaces this the moment one is saved.
//
// Mirrored on purpose: vertical symmetry is what makes a random field read as a FACE
// (the identicon trick), and it is the same recipe the local seeder draws with — the
// look is proven on the board.

import { AVATAR_CELLS, AVATAR_PALETTES, encodeAvatar } from '@whippin/shared';
import { idHash } from './anonName';

export function defaultAvatar(publicId: string): string {
  const seed = idHash(publicId);
  const palette = seed % AVATAR_PALETTES.length;
  const cells = new Array<number>(AVATAR_CELLS).fill(0);
  // A small LCG walks the left half; the right half mirrors it. The outer column ring
  // stays empty so the creature sits inside the tile like the drawn avatars do.
  let state = (seed ^ 0x9e3779b9) >>> 0;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  for (let y = 1; y < 9; y += 1) {
    for (let x = 1; x < 5; x += 1) {
      if (next() < 0.42) {
        cells[y * 10 + x] = 1;
        cells[y * 10 + (9 - x)] = 1;
      }
    }
  }
  return encodeAvatar(palette, cells);
}
