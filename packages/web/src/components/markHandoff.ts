// THE MARK HANDED FROM `/account` TO THE EDITOR: the masthead's mark is the object the editor
// opens as its canvas, so the masthead says where the mark stood when it was tapped, and WHO it
// drew (the face, or null while its read was still out). The editor opens at once on that face
// when it is the account's (`isAccountFace`: its read's, or the seed's a minted account wears)
// and grows its canvas out of that very box; with no such face in hand it holds the box,
// stippled, while it reads the stored profile (`Profile`). A note in memory, good for ONE
// opening within HANDOFF_MS of the tap — a direct load, a reload or a stale note simply grows
// from the canvas's own centre.
import type { Face } from './AccountFace';

const HANDOFF_MS = 1500;

export interface HandedMark {
  rect: DOMRect;
  face: Face | null;
}

let held: (HandedMark & { at: number }) | null = null;

export function handOffMark(rect: DOMRect, face: Face | null): void {
  held = { rect, face, at: performance.now() };
}

export function takeMark(): HandedMark | null {
  const note = held;
  held = null;
  return note && performance.now() - note.at < HANDOFF_MS ? { rect: note.rect, face: note.face } : null;
}
