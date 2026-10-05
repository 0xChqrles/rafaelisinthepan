import { useEffect } from 'react';

// YOUR LINE STAYS IN SIGHT (CSS: sticky under the board screen's held head and on the window's
// foot): this says WHEN it is held at an edge rather than standing in its place — `data-stuck`
// on it, `top` or `bottom` — so the lines passing under it thin out through a dithered edge
// there instead of being cut. Its place is read off the line before it (or its list's top); `data-`
// because the line's class is React's. `watch` names what the column shows: a new board, a
// refresh bringing your line or moving it starts the watch again. The page is the scroller: the
// held head's foot (`--board-top`) is the top edge, the window's foot the bottom one.
export default function useStuckOwnLine(column: { current: HTMLDivElement | null }, watch: string) {
  useEffect(() => {
    const me = column.current?.querySelector<HTMLElement>('.board-under-in .board-row.me');
    if (!me) return undefined;
    const read = () => {
      const before = me.previousElementSibling as HTMLElement | null;
      const edge = before ? before.getBoundingClientRect().bottom : (me.parentElement?.getBoundingClientRect().top ?? 0);
      const held = parseFloat(getComputedStyle(me).top) || 0;
      const stuck = edge < held - 0.5 ? 'top' : edge + me.offsetHeight > window.innerHeight + 0.5 ? 'bottom' : null;
      if (stuck) me.dataset.stuck = stuck;
      else delete me.dataset.stuck;
    };
    read();
    window.addEventListener('scroll', read, { passive: true });
    window.addEventListener('resize', read);
    return () => {
      window.removeEventListener('scroll', read);
      window.removeEventListener('resize', read);
    };
  }, [column, watch]);
}
