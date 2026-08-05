import { useCallback, useEffect, useState } from 'react';
import type { RefObject } from 'react';

// Which way a scroller still runs past its visible edges — the state behind the TORN
// dashed rules a scrolling drawing wears on the side that continues (the onboarding's
// routes teaser, #155, and Word mode's board, #156, which both draw a line taller than
// its window and must not let an edge read as the end of the map).
//
// Shared because the details are the whole of it, and two copies would drift:
//   - the SLACK: a scrollport parked exactly on an edge reports a fractional remainder
//     (scrollTop is fractional on a non-integer device ratio, clientHeight is rounded),
//     so a bare comparison flickers that edge's rule on and off;
//   - the BAIL-OUT on an unchanged value: a scroll event fires per frame, over a line of
//     ~100 rows;
//   - the RESIZE listener: a rotation or a dragged window changes clientHeight/
//     scrollHeight under an unchanged scrollTop, so the edges go stale with no scroll
//     event to catch it.
//
// The caller keeps its own scrolling — where it parks, what it scrolls into view — and
// calls `readEdges` whenever it moves the scroller or its content changes, besides
// wiring it to `onScroll`.
const EDGE_SLACK = 1;

export interface ScrollEdges {
  up: boolean;
  down: boolean;
}

export default function useScrollEdges(ref: RefObject<HTMLElement | null>): {
  more: ScrollEdges;
  readEdges: () => void;
} {
  const [more, setMore] = useState<ScrollEdges>({ up: false, down: false });

  const readEdges = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const up = el.scrollTop > EDGE_SLACK;
    const down = el.scrollTop + el.clientHeight < el.scrollHeight - EDGE_SLACK;
    setMore((prev) => (prev.up === up && prev.down === down ? prev : { up, down }));
  }, [ref]);

  useEffect(() => {
    window.addEventListener('resize', readEdges);
    return () => window.removeEventListener('resize', readEdges);
  }, [readEdges]);

  return { more, readEdges };
}
