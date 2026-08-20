// A player with no display name yet still needs something a human can read — the raw
// publicId on a board row reads as a machine talking (user feedback 2026-08-20). So an
// unnamed player wears a GAMERTAG-style pseudonym (second pass, same day: the first
// cut's pronounceable syllables — "Fototi" — didn't read as a username; games hand out
// AdjectiveNoun handles, so this does too): `SwiftFalcon84`, derived deterministically
// from the publicId, identical on every surface, every device and every friend's board,
// with nothing stored anywhere. The server still holds '' and the profile editor still
// starts blank; this is display only, and a real name replaces it the moment one is
// saved.
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
