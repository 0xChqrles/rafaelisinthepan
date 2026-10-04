// The page's animation clock (the dissolves' own; the board screen and its podium time every
// beat on it, so what script times and what CSS plays never drift apart, whatever the page's
// playback rate): what time it is, and `fn` once `ms` of it has passed (an empty animation on
// `el`) — the wall clock where there is none. `onClock` returns the cancel.
export function clockNow(): number {
  const time = document.timeline?.currentTime;
  return typeof time === 'number' ? time : performance.now();
}

export function onClock(el: HTMLElement | null, ms: number, fn: () => void): () => void {
  if (!el || typeof el.animate !== 'function') {
    const timer = window.setTimeout(fn, ms);
    return () => window.clearTimeout(timer);
  }
  const timer = el.animate([], { duration: ms });
  timer.finished.then(fn, () => {});
  return () => timer.cancel();
}
