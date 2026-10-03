import { useRef, type PointerEvent } from 'react';

// A SIDEWAYS SWIPE on a board's lines turns its tab (user-decided 2026-10-02, the result's
// boards; the board screen since its lines took the result's dress): the lines are most of
// the surface and where a thumb swipes. This far sideways, and mostly sideways — a scroll of
// the page is not one, and the surface keeps its vertical scroll (`touch-action: pan-y` in
// its CSS: the horizontal gesture is the script's). `onSwipe` is told -1 (toward the start)
// or +1 (toward the end); `swiped()` says whether the gesture that just ended was one, so the
// click a mouse fires after it opens nothing.
const SWIPE_PX = 40;

export default function useSwipe(onSwipe: (step: -1 | 1) => void) {
  const start = useRef<{ id: number; x: number; y: number } | null>(null);
  const was = useRef(false);
  const handlers = {
    onPointerDown: (e: PointerEvent) => {
      start.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
      was.current = false;
    },
    onPointerUp: (e: PointerEvent) => {
      const at = start.current;
      start.current = null;
      if (at === null || at.id !== e.pointerId) return;
      const dx = e.clientX - at.x;
      if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < 2 * Math.abs(e.clientY - at.y)) return;
      was.current = true;
      onSwipe(dx < 0 ? 1 : -1);
    },
    onPointerCancel: () => {
      start.current = null;
    },
  };
  // Read once per click: true when the gesture before it was a swipe.
  const swiped = () => {
    const hit = was.current;
    was.current = false;
    return hit;
  };
  return { handlers, swiped };
}
