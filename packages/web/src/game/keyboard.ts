// The custom on-screen keyboard's layouts + live vocab validation (issue #36).
//
// Two responsibilities live here, both pure so they can be unit-tested:
//   1. Layout definitions (AZERTY / QWERTY) and their selection.
//   2. Prefix validation: which letters can still extend the current input into
//      SOME real vocab word. The source is the existence set (public/vocab/<lang>.json),
//      never a puzzle's rank map — this is input validation, not a gameplay hint.
//
// Only [a-z] and the internal dash exist as keys (the fold() slug alphabet): accents
// add nothing because fold() neutralizes them before any comparison.

export type Layout = 'azerty' | 'qwerty';

// Letter rows per layout. Only the ORDER differs between layouts — both expose the
// full a–z, so the greyed-out logic is identical; the control keys (dash, backspace,
// enter, layout-switch) are rendered around these rows by the Keyboard component.
export const LAYOUTS: Record<Layout, readonly (readonly string[])[]> = {
  qwerty: [
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
    ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
  ],
  azerty: [
    ['a', 'z', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['q', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm'],
    ['w', 'x', 'c', 'v', 'b', 'n'],
  ],
};

// The layout inferred from the puzzle language — used ONLY on first use (before the
// player has ever picked a global preference). fr -> AZERTY, everything else -> QWERTY.
export function defaultLayoutForLang(lang: string): Layout {
  return lang === 'fr' ? 'azerty' : 'qwerty';
}

// The other layout — what the layout-switch key flips to.
export function otherLayout(layout: Layout): Layout {
  return layout === 'azerty' ? 'qwerty' : 'azerty';
}

// Build a Set of EVERY prefix of every vocab word, the full word included:
// "chat" -> "c", "ch", "cha", "chat". The empty string is intentionally NOT added
// (the empty-input case is answered by prefixSet.has("" + letter) = prefixSet.has(letter)).
//
// DECIDED (issue #36): a flat Set, NOT a trie. At ~400k words a JS trie is GC/memory
// hostile (hundreds of thousands of node objects); a flat Set of the ~2.5–3M distinct
// short prefixes is O(1) per lookup and builds in one linear pass. Words are already
// folded slugs ([a-z] + internal dash), so a partial hyphenated word like "arc-" is a
// real prefix of "arc-en-ciel" and stays typable.
export function buildPrefixSet(vocab: Iterable<string>): Set<string> {
  const prefixes = new Set<string>();
  for (const word of vocab) {
    for (let i = 1; i <= word.length; i += 1) {
      prefixes.add(word.slice(0, i));
    }
  }
  return prefixes;
}

// Can `char` extend `input` into some real word? i.e. is (input + char) a prefix of
// at least one vocab word. Drives the greyed-out state of every letter and the dash.
// Empty input works out of the box: canExtend(set, "", "c") = set.has("c").
export function canExtend(prefixSet: Set<string>, input: string, char: string): boolean {
  return prefixSet.has(input + char);
}
