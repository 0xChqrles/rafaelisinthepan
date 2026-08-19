// A player with no display name yet still needs something a human can read — the raw
// publicId on a board row reads as a machine talking (user feedback 2026-08-20). So an
// unnamed player wears a PSEUDONYM: pronounceable consonant-vowel syllables derived
// deterministically from the publicId, so the same player reads the same on every
// surface, every device and every friend's board — with nothing stored anywhere. The
// server still holds '' and the profile editor still starts blank; this is display
// only, and a real name replaces it the moment one is saved.
//
// The alphabet is alphanumeric on purpose: a pseudonym is something `sanitizeName`
// would accept unchanged, so it never LOOKS like a value the name field could not hold.

const CONSONANTS = 'bdfgklmnprstvz';
const VOWELS = 'aeiou';

export function anonName(publicId: string): string {
  // FNV-1a over the id — enough spread for a display fallback (collisions cost nothing).
  let h = 2166136261 >>> 0;
  for (let i = 0; i < publicId.length; i += 1) {
    h = Math.imul(h ^ publicId.charCodeAt(i), 16777619) >>> 0;
  }
  let name = '';
  for (let i = 0; i < 3; i += 1) {
    name += CONSONANTS[h % CONSONANTS.length];
    h = Math.floor(h / CONSONANTS.length);
    name += VOWELS[h % VOWELS.length];
    h = Math.floor(h / VOWELS.length);
  }
  return name[0].toUpperCase() + name.slice(1);
}
