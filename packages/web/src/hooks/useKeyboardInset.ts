// THE SOFT KEYBOARD'S HEIGHT, as a CSS variable — the one thing the stylesheet cannot see.
//
// `interactive-widget=resizes-content` (index.html) makes the LAYOUT viewport shrink when
// the keyboard opens, which is exactly what lets `.account-screen`'s `max-height: 100%` +
// `overflow-y: auto` scroll its own bottom into reach. Chrome Android implements it. iOS
// Safari does not: there the layout viewport is unchanged, so nothing overflows, nothing
// scrolls, and on the code step the wrong-code line and RESEND sit under the keyboard with
// no gesture that can reach them — the message a refused code exists to deliver, delivered
// off-screen.
//
// So the inset is MEASURED rather than assumed. Where the layout viewport already resized,
// `innerHeight` shrank with it and the difference is ~0 — the hook is self-neutralising,
// never a second correction stacked on a browser that already did the work.
import { useEffect } from 'react';

const VAR = '--kb-inset';
// No soft keyboard is shorter than this. The floor keeps the ordinary reasons the two
// viewports disagree — a collapsing URL bar, a pinch-zoom — from re-laying out the column
// for a few pixels that were never a keyboard.
const MIN_KEYBOARD_PX = 48;

export default function useKeyboardInset(): void {
  useEffect(() => {
    const viewport = typeof window === 'undefined' ? null : window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    const apply = () => {
      // Whole pixels: the value lands in a `padding-bottom`, and a fractional one would
      // re-lay the column out on every fine-grained viewport event.
      const gap = Math.round(window.innerHeight - viewport.height - viewport.offsetTop);
      root.style.setProperty(VAR, `${gap >= MIN_KEYBOARD_PX ? gap : 0}px`);
    };
    apply();
    // `scroll` as well as `resize`: iOS pans the visual viewport as the keyboard opens, so
    // `offsetTop` moves after the height has already settled.
    viewport.addEventListener('resize', apply);
    viewport.addEventListener('scroll', apply);
    return () => {
      viewport.removeEventListener('resize', apply);
      viewport.removeEventListener('scroll', apply);
      root.style.removeProperty(VAR);
    };
  }, []);
}
