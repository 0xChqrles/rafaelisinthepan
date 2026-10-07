// IS ANYBODY WATCHING a raster's clock (the podium's, the archive's month, the account's record,
// an article figure's loop):
// a scene at rest moves only its loop (a foil, a flame, a read wave), and that loop rests while
// nobody can SEE it — what draws it scrolled out of view, the tab hidden. `wake` is told whenever
// the answer may have turned to yes (back in view, the tab shown): each clock keeps its own tick
// and decides what a yes starts.
//
// A loop never rests merely because nobody has TOUCHED the page lately (user-reported
// 2026-10-05: the flame and the podium's foil "freeze completely, until you click on the
// page"): a picture on screen that stops moving reads as a frozen app, not as a saving.

// The archive's read wave steps at the meter's pace: a loading wave is stepped by design.
export const LOOP_FRAME_MS = 80;

export interface RasterWatch {
  // On screen, in a visible tab.
  seen: () => boolean;
  stop: () => void;
}

export function watchRaster(el: Element, wake: () => void): RasterWatch {
  let inView = true;
  const io =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((entries) => {
          // The latest word on it: a batch can hold an entry and the exit after it.
          inView = entries[entries.length - 1].isIntersecting;
          wake();
        })
      : null;
  io?.observe(el);
  document.addEventListener('visibilitychange', wake);
  return {
    seen: () => inView && !document.hidden,
    stop: () => {
      io?.disconnect();
      document.removeEventListener('visibilitychange', wake);
    },
  };
}
