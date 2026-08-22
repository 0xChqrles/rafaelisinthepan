// WHICH puzzle a round's state belongs to (#201), and — since #203 — which puzzle a
// DERIVATION ARTIFACT describes.
//
// A round key is only (day, lang, mode), so re-publishing a different sentence keeps the
// key while changing the puzzle entirely. The tag is what tells them apart: the client
// computes it from the holes it is playing, the server stores it beside the log and only
// ever compares it for equality, and a read for a different tag is an honest "nothing
// stored for this one".
//
// It moved here from the web when #203 stamped it into the slice. The server does not
// merely relay the tag any more — it has to decide whether the artifact it is about to
// derive against describes the puzzle the caller is playing, which means computing the same
// value from a `Puzzle`. Two spellings would let an artifact claim a revision it is not.
//
// FNV-1a, base 36, so any signature becomes a handful of characters that fit the wire
// shape. ONE encoding for every daily: two would be two ways for a tag to stop matching
// itself.
export function fnvTag(signature: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < signature.length; i += 1) {
    hash ^= signature.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

// The SENTENCE puzzle's revision: every hole's position and secret, in the puzzle's own
// order. It is the signature `holesMatchPuzzle` compares on the client, which is what makes
// "the tag changed" and "the local round resets" the same event.
//
// EVERY occurrence counts, including a repeated secret: the client's runtime holes carry
// one entry per occurrence, so collapsing them here would make the two ends disagree about
// a sentence that says one word twice.
export function puzzleTag(holes: readonly { pos: number; secret: string }[]): string {
  return fnvTag(holes.map((h) => `${h.pos}:${h.secret}`).join('|'));
}
