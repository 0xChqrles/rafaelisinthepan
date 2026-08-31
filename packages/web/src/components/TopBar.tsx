import { useEffect, useRef, useState, type ReactNode } from 'react';
import ArrowLeftIcon from '../assets/icons/arrow-left.svg?react';

// The app header. At REST it is TRANSPARENT — the controls sit directly on the dark grain
// ground — and the glass band + hairline arrive only once the screen under it scrolls (the
// hook below). Mobile-first: full-bleed slim band when scrolled; on desktop the band floats
// capped and rounded just inside the device frame's brackets, a piece of the instrument.
//
// **TWO SLOTS, AND EACH HAS ONE MEANING** (user-decided 2026-08-30, retiring the three-slot
// row whose centre held the segmented mode switcher):
//
//   LEFT   WHAT YOU ARE LOOKING AT. On a play surface that is the daily itself
//          (`PuzzleTitle` — "SENTENCE ⌄", and the day too on an archive route), whose sheet
//          holds every axis of which puzzle: language, daily, day. On a screen you navigated
//          INTO it is `back` — the arrow and the screen's own name as one target.
//   RIGHT  WHERE YOU ARE AND WHERE YOU CAN GO: the state keys, the current one LIT.
//
// The centre is deliberately empty. What that bought is recorded in `PuzzleTitle`: the row
// was colliding with itself at 320px, which is why the leaderboard could not carry a back
// control beside its own title and why there was no room for an account door. After the
// change the tightest case leaves 94px of centre unused.
//
// The two slots are also two NAVIGATION MODELS, and keeping them apart is the point: a key
// is a place (press the crown to see the board; on the board it is LIT), while `back` is a
// STEP inside a place (the editor returns to the account, the code step returns to the
// address). A place opened OVER the game — the board, the archive — leaves by a ✕ in the
// trailing corner, the gesture everybody reads as "close this": a lit key says where you
// are, and a status is not an exit (user feedback 2026-08-31 — leaving by pressing the lit
// key again "is not intuitive at all"). Nothing wears both.

// THE BAND WAITS FOR SCROLL (user-decided 2026-09-01): at rest the header is transparent
// on the dark grain ground, and the glass + hairline arrive only once the surface under
// it has actually scrolled — the moment content could pass beneath the controls. ONE
// capture-phase listener hears every scroller in the app (each screen owns its own; on a
// phone the page itself scrolls), because the header cannot know which screen is under
// it. Three filters keep the signal honest: a DIALOG's scroll never lights the band (the
// header is under the dialog), a horizontal-only scroller says nothing about the
// header's edge, and a scroller that UNMOUNTS (navigation) fires no final scroll event —
// so a post-render check drops a scrolled state whose element left the tree.
function useHeaderScrolled(): boolean {
  const [scrolled, setScrolled] = useState(false);
  const scroller = useRef<Element | null>(null);
  useEffect(() => {
    const onScroll = (e: Event) => {
      const t = e.target;
      const el = t === document ? document.scrollingElement : t instanceof Element ? t : null;
      if (!el || el.closest('dialog')) return;
      if (el.scrollHeight <= el.clientHeight) return;
      if (el.scrollTop > 2) {
        scroller.current = el;
        setScrolled(true);
      } else if (scroller.current === el || !scroller.current?.isConnected) {
        scroller.current = null;
        setScrolled(false);
      }
    };
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => window.removeEventListener('scroll', onScroll, true);
  }, []);
  useEffect(() => {
    const el = scroller.current;
    if (el && (!el.isConnected || el.scrollTop <= 2)) {
      scroller.current = null;
      setScrolled(false);
    }
  });
  return scrolled;
}

export default function TopBar({
  left,
  back,
  right,
}: {
  left?: ReactNode;
  // The screen's title, as the way OUT of it: rendered as the left slot's own button.
  back?: { title: string; label: string; onBack: () => void };
  right?: ReactNode;
}) {
  const scrolled = useHeaderScrolled();
  return (
    <header className={scrolled ? 'topbar scrolled' : 'topbar'}>
      <div className="topbar-inner">
        {back && (
          <div className="topbar-left">
            <button
              type="button"
              className="topbar-back"
              aria-label={back.label}
              onClick={back.onBack}
            >
              <ArrowLeftIcon className="ui-icon" aria-hidden />
              <span className="topbar-title">{back.title}</span>
            </button>
          </div>
        )}
        {left && <div className="topbar-left">{left}</div>}
        <div className="topbar-right">{right}</div>
      </div>
    </header>
  );
}
