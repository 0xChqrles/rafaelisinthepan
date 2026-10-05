// THE MARK HANDED FROM `/account` TO THE EDITOR: the masthead's mark is the object the editor
// opens as its canvas, so the masthead says where the mark stood when it was tapped and the
// editor grows its canvas out of exactly that box (`Profile`). A note in memory, good for ONE
// opening within HANDOFF_MS of the tap — a direct load, a reload, a slow read or a stale note
// simply grows from the canvas's own centre.
const HANDOFF_MS = 1500;

let held: { rect: DOMRect; at: number } | null = null;

export function handOffMark(rect: DOMRect): void {
  held = { rect, at: performance.now() };
}

export function takeMark(): DOMRect | null {
  const note = held;
  held = null;
  return note && performance.now() - note.at < HANDOFF_MS ? note.rect : null;
}
