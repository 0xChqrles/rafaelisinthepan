// The cross-language slug contract. This JS fold() MUST stay byte-identical to the
// Python slug() in packages/generation/scripts/gen_phrase.py: lowercase -> expand
// ligatures (oe/ae) -> NFKD -> drop combining marks -> keep only [a-z] and '-' ->
// collapse repeated dashes -> trim edge dashes. Accents are for DISPLAY; the slug is
// for COMPARISON. Never fold/slug a displayed form, and never display a slug.

// Ligatures that do NOT decompose under NFKD, so we expand them by hand
// (matches gen_phrase.py slug()).
const LIGATURES: Record<string, string> = { œ: 'oe', æ: 'ae' };

// Fold a guess to its slug: the same ASCII key gen_phrase.py uses for lookups
// (lowercase, ligatures expanded, accents removed, letters and INTERNAL dashes
// only). Accents must be folded BEFORE stripping so "foret" keeps its letters; dashes
// survive so "peut-etre" stays hyphenated. Byte-identical to the Python slug().
export function fold(str: string) {
  let s = str.toLowerCase();
  for (const [lig, repl] of Object.entries(LIGATURES)) s = s.split(lig).join(repl);
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // drop combining marks
    .replace(/[^a-z-]/g, '') // keep only a-z and dash
    .replace(/-+/g, '-') // collapse repeated dashes
    .replace(/^-+|-+$/g, ''); // trim leading/trailing dashes
}
