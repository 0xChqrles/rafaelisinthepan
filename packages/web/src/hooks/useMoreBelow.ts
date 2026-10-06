import { useCallback, useEffect, useState } from 'react';

// Whether a scrolling LIST holds more below what it shows — what puts the house's deep
// dithered edge at its foot (`data-more`, index.css): the last line shown thins through the
// Bayer cells, saying more wait below, and a list resting on its last line (or holding every
// line) ends clean, so the frame of a line standing there is never thinned. Measured again on
// the list's own scroll, on its box resizing, and on its rows changing — a row added or
// removed under a capped box that keeps its size (a member removed, a stale pick read again)
// moves neither of the other two.
export default function useMoreBelow<T extends HTMLElement>(): [(el: T | null) => void, boolean] {
  const [el, setEl] = useState<T | null>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    if (!el) return undefined;
    const measure = () => setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(measure);
    mo?.observe(el, { childList: true });
    return () => {
      el.removeEventListener('scroll', measure);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [el]);
  return [useCallback((node: T | null) => setEl(node), []), more];
}
