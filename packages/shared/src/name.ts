// The #188 display-name rule, and it is a CROSS-PACKAGE CONTRACT (user-decided
// 2026-08-19: "the server should apply the same rules"). The WEB sanitizes what the
// player types, the BACKEND refuses anything that is not already sanitized — two
// implementations would let the front promise a shape the store does not hold, which
// is exactly what the first cut of this rule did (it lived in one onChange handler
// and nothing else in the system knew about it).
//
// A name is ALPHANUMERICS AND UNDERSCORES, case kept, at most 16 characters:
//
//   lowercase is NOT applied (a name is a display form) -> expand the ligatures NFKD
//   leaves alone (oe/ae, slug.ts's own list) -> NFKD -> drop combining marks -> map
//   every remaining non-[A-Za-z0-9] CODE POINT to '_' -> cap at NAME_MAX_LENGTH.
//
// Accents are FOLDED, not underscored (`Zoé` -> `Zoe`, `Éléonore` -> `Eleonore`,
// `François` -> `Francois`). The first cut mapped them to '_' with the punctuation,
// which spelled `Zo_` on the one language half this game is written for. Folding is
// the accent treatment the repo already owns — `fold()` in slug.ts runs the same
// decompose-and-strip pipeline — and it keeps the LETTERS the player typed.
//
// NFKD before the map is also what makes the rule stable under normalization: NFC
// `café` and NFD `café` are the same name to a reader, and without a normalizing pass
// they sanitize to `caf_` and `cafe_`. The map matches per CODE POINT (the `u` flag),
// so one astral character costs one underscore rather than one per surrogate half.
//
// `sanitizeName` is IDEMPOTENT — its output is `[A-Za-z0-9_]{0,16}` and '_' maps to
// itself — which is what lets a valid name be defined as one the sanitizer leaves
// alone. One function owns the rule; there is no second spelling of it to drift.

export const NAME_MAX_LENGTH = 16;

// The ligatures NFKD does not decompose, expanded by hand (slug.ts's LIGATURES, with
// the capitals a display form can carry).
const LIGATURES: Record<string, string> = { œ: 'oe', Œ: 'OE', æ: 'ae', Æ: 'AE' };

export function sanitizeName(raw: string): string {
  let name = raw;
  for (const [lig, repl] of Object.entries(LIGATURES)) name = name.split(lig).join(repl);
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '') // drop combining marks — `é` keeps its `e`
    .replace(/[^A-Za-z0-9]/gu, '_')
    .slice(0, NAME_MAX_LENGTH);
}

// A name is valid exactly when the sanitizer has nothing to do to it. The cap rides
// along for free (sanitizeName truncates), and so does the old control/format-character
// rule (a `\p{Cc}`/`\p{Cf}` character is not alphanumeric, so it maps to '_').
// The EMPTY name stays valid — the avatar alone is a profile.
export function isValidName(name: string): boolean {
  return sanitizeName(name) === name;
}
