// THE MARK HANDED FROM `/account` TO THE EDITOR: the masthead's mark is the object the editor
// opens as its canvas, so the masthead says where the mark stood when it was tapped, and WHICH
// mark it was (the encoded avatar it drew, or null while its face was still being read). The
// editor holds that very mark, frozen in that very box, while it reads the stored profile, and
// then grows its canvas out of it (`Profile`). A note in memory, good for ONE opening within
// HANDOFF_MS of the tap — a direct load, a reload or a stale note simply grows from the
// canvas's own centre.
const HANDOFF_MS = 1500;

export interface HandedMark {
  rect: DOMRect;
  avatar: string | null;
}

let held: (HandedMark & { at: number }) | null = null;

export function handOffMark(rect: DOMRect, avatar: string | null): void {
  held = { rect, avatar, at: performance.now() };
}

export function takeMark(): HandedMark | null {
  const note = held;
  held = null;
  return note && performance.now() - note.at < HANDOFF_MS ? { rect: note.rect, avatar: note.avatar } : null;
}
