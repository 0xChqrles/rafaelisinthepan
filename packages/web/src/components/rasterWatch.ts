// IS ANYBODY WATCHING a raster's clock (the podium's, the archive's month): a scene at rest
// moves only its loop (a foil, a read wave), and that loop rests too while nobody can SEE it —
// its canvas scrolled out of view, the tab hidden — or nobody is THERE: IDLE_MS after the last
// touch, key, wheel or scroll, until the next one. `wake` is told whenever the answer may have
// turned to yes (back in view, the tab shown, a touch after the idle): each clock keeps its own
// tick and decides what a yes starts.

// A loop at rest steps at the meter's pace: pixel art has nothing to gain from 60fps.
export const LOOP_FRAME_MS = 80;
// After this long without a touch, a key, a wheel or a scroll, nobody is there.
const IDLE_MS = 9000;

export interface RasterWatch {
  // On screen, in a visible tab.
  seen: () => boolean;
  // Somebody touched the page in the last IDLE_MS.
  awake: () => boolean;
  stop: () => void;
}

export function watchRaster(canvas: HTMLCanvasElement, wake: () => void): RasterWatch {
  let inView = true;
  let awake = true;
  let idle = 0;
  const touched = () => {
    window.clearTimeout(idle);
    idle = window.setTimeout(() => {
      awake = false;
    }, IDLE_MS);
    if (!awake) {
      awake = true;
      wake();
    }
  };
  const io =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((entries) => {
          // The latest word on it: a batch can hold an entry and the exit after it.
          inView = entries[entries.length - 1].isIntersecting;
          wake();
        })
      : null;
  io?.observe(canvas);
  document.addEventListener('visibilitychange', wake);
  const events = ['pointerdown', 'keydown', 'wheel', 'scroll'] as const;
  for (const name of events) window.addEventListener(name, touched, { capture: true, passive: true });
  touched();
  return {
    seen: () => inView && !document.hidden,
    awake: () => awake,
    stop: () => {
      window.clearTimeout(idle);
      io?.disconnect();
      document.removeEventListener('visibilitychange', wake);
      for (const name of events) window.removeEventListener(name, touched, { capture: true });
    },
  };
}
