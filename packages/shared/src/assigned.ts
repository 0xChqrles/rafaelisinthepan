// The ASSIGNED identity (#188/#190): what a player who has never customized a profile
// looks like — a gamertag pseudonym and a generated 10×10 mark, both pure functions of
// the publicId, nothing stored anywhere. A saved profile replaces them; the server still
// holds '' / null.
//
// This lives in shared because "identical on every surface" is a cross-package claim now
// (moved here 2026-08-20, when the invite link's OG card started drawing a player
// server-side): the WEB draws it on every board row, the profile editor and the invite
// landing, and the BACKEND draws it on the invite card that unfurls in a chat. Two
// implementations would hand one player two different faces depending on who was looking.
//
// Both are DISPLAY-only, in both directions: an assigned name is never stored (a board
// gates its placeholder ink on the stored name being EMPTY), and the editor saves the
// empty name when a player leaves their pseudonym untouched.

import { AVATAR_CELLS, AVATAR_PALETTES, encodeAvatar } from './avatar';

// A player with no display name yet still needs something a human can read — the raw
// publicId on a board row reads as a machine talking (user feedback 2026-08-20). So an
// unnamed player wears a GAMERTAG-style pseudonym (second pass, same day: the first
// cut's pronounceable syllables — "Fototi" — didn't read as a username; games hand out
// AdjectiveNoun handles, so this does too): `SwiftFalcon84`, derived deterministically
// from the publicId, identical on every surface, every device and every friend's board.
//
// The parts are length-budgeted against the shared name cap (6 + 7 + 2 ≤ 16) and the
// alphabet is alphanumeric, so a pseudonym is always a value `sanitizeName` would
// accept unchanged — it never LOOKS like something the name field could not hold.

const ADJECTIVES = [
  'Swift', 'Turbo', 'Wobbly', 'Mellow', 'Rapid', 'Cosmic', 'Shiny', 'Lucky',
  'Salty', 'Spicy', 'Chill', 'Feral', 'Golden', 'Rusty', 'Zesty', 'Fuzzy',
];

const NOUNS = [
  'Falcon', 'Penguin', 'Wizard', 'Goblin', 'Otter', 'Nugget', 'Raccoon', 'Cactus',
  'Pickle', 'Walrus', 'Ninja', 'Yeti', 'Mango', 'Badger', 'Comet', 'Biscuit',
];

// FNV-1a over the id — enough spread for a display fallback (collisions cost nothing).
export function idHash(publicId: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < publicId.length; i += 1) {
    h = Math.imul(h ^ publicId.charCodeAt(i), 16777619) >>> 0;
  }
  return h;
}

export function anonName(publicId: string): string {
  let h = idHash(publicId);
  const adjective = ADJECTIVES[h % ADJECTIVES.length];
  h = Math.floor(h / ADJECTIVES.length);
  const noun = NOUNS[h % NOUNS.length];
  h = Math.floor(h / NOUNS.length);
  // The two-digit tail every gamertag drags around — and most of the spread, so two
  // strangers sharing SwiftFalcon still read apart.
  return `${adjective}${noun}${10 + (h % 90)}`;
}

// A player with no drawn avatar still gets a MARK (user feedback 2026-08-20 — the
// dashed empty frame read as a hole in the board): a small mirrored 10×10 creature
// generated deterministically from the publicId, in one of the real palettes.
//
// Mirrored on purpose: vertical symmetry is what makes a random field read as a FACE
// (the identicon trick), and it is the same recipe the local seeder draws with — the
// look is proven on the board.
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
