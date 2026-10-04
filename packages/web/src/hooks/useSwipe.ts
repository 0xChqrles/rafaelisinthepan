import { useRef, type PointerEvent } from 'react';

// A SIDEWAYS SWIPE on a board's lines turns its tab (user-decided 2026-10-02, the result's
// boards; the board screen since its lines took the result's dress): the lines are most of
// the surface and where a thumb swipes. This far sideways, and mostly sideways — a scroll of
// the page is not one, and the surface keeps its vertical scroll and its pinch (`touch-action:
// pan-y pinch-zoom` in its CSS: the horizontal gesture is the script's). A FINGER's or a pen's
// alone, the first one down: a mouse dragging across the lines is selecting a name (it turns
// nothing, and the click it ends in opens nothing either), and a second finger or another
// button is not a swipe. `onSwipe` is told -1 (toward the start) or +1 (toward the end);
// `swiped()` says whether a swipe or a drag ended just now (SWIPE_CLICK_MS), so the click it can
// fire after it opens nothing — and a click long after (a key's) is a click.
const SWIPE_PX = 40;
const SWIPE_CLICK_MS = 400;

export default function useSwipe(onSwipe: (step: -1 | 1) => void) {
  const start = useRef<{ id: number; x: number; y: number; mouse: boolean } | null>(null);
  const endedAt = useRef(-Infinity);
  const handlers = {
    onPointerDown: (e: PointerEvent) => {
      start.current =
        e.isPrimary && e.button === 0
          ? { id: e.pointerId, x: e.clientX, y: e.clientY, mouse: e.pointerType === 'mouse' }
          : null;
    },
    onPointerUp: (e: PointerEvent) => {
      const at = start.current;
      start.current = null;
      if (at === null || at.id !== e.pointerId) return;
      const dx = e.clientX - at.x;
      const dy = e.clientY - at.y;
      if (at.mouse) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) >= SWIPE_PX) endedAt.current = e.timeStamp;
        return;
      }
      if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < 2 * Math.abs(dy)) return;
      endedAt.current = e.timeStamp;
      onSwipe(dx < 0 ? 1 : -1);
    },
    onPointerCancel: () => {
      start.current = null;
    },
  };
  // Read once per click: true when a swipe (or a mouse's drag) ended just before it.
  const swiped = (e: { timeStamp: number }) => {
    const hit = e.timeStamp - endedAt.current < SWIPE_CLICK_MS;
    endedAt.current = -Infinity;
    return hit;
  };
  return { handlers, swiped };
}
