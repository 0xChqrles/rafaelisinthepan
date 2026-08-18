// The #188 display-name filter: cheap, server-side, rejects on write. A banned-STRINGS
// check, deliberately not a classifier — it normalizes away the easy disguises (case,
// accents, spacing, digit-for-letter substitutions) and refuses a name containing any
// listed term. Best-effort by design, like the avatar's symbol check: the real
// containment is the friends model (#189), where the default board only shows people
// you chose to add.

// Digit/symbol stand-ins folded to the letters they imitate BEFORE matching, so
// "H1tl3r" and "n a z i" normalize onto their banned forms.
const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '@': 'a',
  $: 's',
  '!': 'i',
};

export function normalizeName(name: string): string {
  const folded = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '');
  let out = '';
  for (const char of folded) {
    const mapped = LEET[char] ?? char;
    if (/[a-z]/.test(mapped)) out += mapped;
  }
  return out;
}

// Terms are chosen long/distinct enough that a substring match stays high-signal
// (no three-letter entries that live inside ordinary words). Extend the list as
// moderation needs arise — matching is on the NORMALIZED name.
const BANNED: readonly string[] = [
  // Nazi references.
  'hitler',
  'nazi',
  'swastika',
  'gestapo',
  // English slurs.
  'nigger',
  'nigga',
  'faggot',
  'kike',
  'chink',
  'wetback',
  'raghead',
  'tranny',
  // French slurs & abuse.
  'negre',
  'youpin',
  'bougnoule',
  'bicot',
  'niakoue',
  'encule',
];

export function isNameAllowed(name: string): boolean {
  const normalized = normalizeName(name);
  return !BANNED.some((term) => normalized.includes(term));
}
