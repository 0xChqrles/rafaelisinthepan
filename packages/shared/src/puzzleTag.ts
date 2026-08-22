// The short opaque tags a round's state is keyed by.
//
// A round key is only (day, lang, mode), so re-publishing keeps the key while changing the
// puzzle. The tag is what tells them apart: the client sends it, the server stores it beside
// the log and only ever compares it for equality, and a read for a different tag is an
// honest "nothing stored for this one".
//
// The SENTENCE daily's tag is the published puzzle's own `revision` (#203) — a version
// stamped by `puzzle:publish`, which is the only thing that can tell a corrected puzzle from
// the one it replaces when the sentence itself has not changed. It needs no encoding here.
// What remains is Word mode's, which is still derived from the day's word.
//
// FNV-1a, base 36, so any signature becomes a handful of characters that fit the wire shape.
export function fnvTag(signature: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < signature.length; i += 1) {
    hash ^= signature.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
