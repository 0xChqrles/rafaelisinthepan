import { useCallback, useEffect, useState } from 'react';

// Whether a scrolling LIST holds more below what it shows — what puts the house's dithered
// edge at its foot (`data-more`, index.css): a line passing out there thins through the Bayer
// cells, and a list resting on its last line (or holding every line) ends clean, so the frame
// of a line standing there is never thinned. Hears the list's own scroll and its resizes.
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
    return () => {
      el.removeEventListener('scroll', measure);
      ro?.disconnect();
    };
  }, [el]);
  return [useCallback((node: T | null) => setEl(node), []), more];
}
