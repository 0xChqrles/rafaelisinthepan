// WHERE A LESSON STARTED FROM THE INVITATION GOES BACK TO (`App`'s `lessonReturn`: the path
// TUTORIAL was pressed on — a shared day's, a bonus's) is held in memory, so a reload drops it.
// It is kept across the ONE reload the app itself makes on a lesson: a lost chunk's RETRY
// (`hooks/lazyChunk`, which can only fetch the chunk again from a new document), so the
// newcomer it sends back to the lesson still lands, on PLAY or SKIP, on the day they were
// invited to. This tab only (sessionStorage), read once and removed.
const KEY = 'whippin-lesson-return';

// Kept just before RETRY reloads. Storage that cannot be written keeps nothing: the reloaded
// lesson then goes on to the plain game, as any reload does.
export function stashLessonReturn(path: string | undefined): void {
  if (!path) return;
  try {
    sessionStorage.setItem(KEY, path);
  } catch {
    // Unwritable storage: nothing kept.
  }
}

let taken: { path: string | undefined } | null = null;

// What a RETRY's reload kept, read ONCE per page and removed from storage — the same answer to
// every later call in this document (React may run a state initializer twice).
export function stashedLessonReturn(): string | undefined {
  if (taken === null) {
    let path: string | undefined;
    try {
      const held = sessionStorage.getItem(KEY);
      sessionStorage.removeItem(KEY);
      path = held !== null && held.startsWith('/') ? held : undefined;
    } catch {
      path = undefined;
    }
    taken = { path };
  }
  return taken.path;
}
