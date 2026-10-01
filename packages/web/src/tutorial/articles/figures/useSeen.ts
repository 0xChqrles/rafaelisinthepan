import { useEffect, useState } from 'react';
import type { RefObject } from 'react';

// Whether an element has come into view at least once — a figure's drawing waits for its
// reader instead of playing to an empty screen. No IntersectionObserver (old browsers, the
// tests' static render): seen at once.
const MARGIN = '0px 0px -12% 0px';

export default function useSeen(ref: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return undefined;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: MARGIN },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, seen]);
  return seen;
}
