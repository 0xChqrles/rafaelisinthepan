import { useEffect } from 'react';

// YOUR LINE STAYS IN SIGHT (CSS: sticky at both edges of the board screen's column): this says
// WHEN it is held at an edge rather than standing in its place — `data-stuck` on it, `top` or
// `bottom` — so the lines passing under it thin out through a dithered edge there instead of
// being cut. Its place is read off the line before it (or its list's top); `data-` because the
// line's class is React's. `watch` names what the column shows: a new board, a refresh bringing
// your line or moving it starts the watch again.
export default function useStuckOwnLine(column: { current: HTMLDivElement | null }, watch: string) {
  useEffect(() => {
    const scroller = column.current;
    const me = scroller?.querySelector<HTMLElement>('.board-under-in .board-row.me');
    if (!scroller || !me) return undefined;
    const read = () => {
      const before = me.previousElementSibling as HTMLElement | null;
      const edge = before ? before.getBoundingClientRect().bottom : (me.parentElement?.getBoundingClientRect().top ?? 0);
      const top = edge - scroller.getBoundingClientRect().top;
      const stuck = top < -0.5 ? 'top' : top + me.offsetHeight > scroller.clientHeight + 0.5 ? 'bottom' : null;
      if (stuck) me.dataset.stuck = stuck;
      else delete me.dataset.stuck;
    };
    read();
    scroller.addEventListener('scroll', read, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    ro?.observe(scroller);
    return () => {
      scroller.removeEventListener('scroll', read);
      ro?.disconnect();
    };
  }, [column, watch]);
}
