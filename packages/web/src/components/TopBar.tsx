import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import ChevronLeftIcon from '../assets/icons/chevron-left.svg?react';

// The app header. At REST it is TRANSPARENT — the controls sit directly on the dark grain
// ground — and the glass band + hairline arrive only once the screen under it scrolls (the
// hook below). Mobile-first: full-bleed slim band when scrolled; on desktop the band floats
// capped and rounded just inside the device frame's brackets, a piece of the instrument.
//
// **THE ROW IS APP CHROME, NOT SCREEN CONTENT (2026-09-02).** Every screen used to render
// its own TopBar, so tapping a header key unmounted the whole row and mounted a different
// screen's copy of it: the player's own face went back to its skeleton and re-read its
// profile over the network on every navigation, which read as the page reloading
// (user-reported). The row is mounted ONCE, by App, and outlives the screens under it — the
// literal reading of the decision it already carried ("the header is supposed to be
// something stable"). What genuinely varies per screen is the LEFT slot, so a screen
// publishes THAT through `HeaderLeft`: the slot keeps belonging to the screen (it owns what
// it says there, and the state its controls close over comes with it) without the screen
// owning the row.
//
// **TWO SLOTS, AND EACH HAS ONE MEANING** (user-decided 2026-08-30, retiring the three-slot
// row whose centre held the segmented mode switcher):
//
//   LEFT   WHAT YOU ARE LOOKING AT. On a play surface that is the daily itself
//          (`PuzzleTitle` — "SENTENCE ⌄", and the day too on an archive route), whose sheet
//          holds every axis of which puzzle: language, daily, day. On a screen you navigated
//          INTO it is `HeaderBack` — the arrow and the screen's own name as one target.
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
// address). A place opened OVER the game — the board, the archive — leaves by tapping
// another key, the gesture a tab bar needs no exit control for: a lit key says where you
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

// The left slot's node, made once and reused for the app's life. It is a portal TARGET, so
// it has to EXIST before the screens render into it — a ref is still null on their first
// pass, and holding it in state would re-render the whole tree every time the header
// mounts. React never owns its children (the portal does), and the header only ever
// appends it, so no React-managed sibling is ever mutated. `display: contents` keeps it out
// of the layout entirely: what a screen publishes are the flex items of `.topbar-left`
// itself, exactly as they were when the screen rendered them there.
let slot: HTMLElement | null = null;
function leftSlot(): HTMLElement | null {
  // Component tests render to static markup with no DOM (`renderToStaticMarkup`), where a
  // portal has nowhere to go and the header's left slot is simply not part of the output.
  if (typeof document === 'undefined') return null;
  if (slot === null) {
    slot = document.createElement('div');
    slot.style.display = 'contents';
  }
  return slot;
}

// WHAT A SCREEN PUTS IN THE HEADER'S LEFT SLOT, mounted from wherever the screen likes and
// rendered into the row's own left track.
export function HeaderLeft({ children }: { children: ReactNode }) {
  const node = leftSlot();
  return node ? createPortal(children, node) : null;
}

// A STEP's way back: a LEFT CHEVRON and the screen's own name as ONE target, in the left
// slot where the eye already is when it reads what screen it is on (user-decided
// 2026-08-29). It REPLACES a title rather than sitting beside it, so the row's measured
// width budget is unchanged. The chevron is the title's own 7×7 pixel mark turned to point
// out (user-decided 2026-09-02, "use a left chevron as a back icon on the header",
// replacing the 10×10 pixel arrow): the way INTO the title and the way BACK out of a step
// are one glyph, and the arrow read as a different kind of thing beside it.
export function HeaderBack({
  title,
  label,
  onBack,
}: {
  title: string;
  label: string;
  onBack: () => void;
}) {
  return (
    <button type="button" className="topbar-back" aria-label={label} onClick={onBack}>
      <ChevronLeftIcon className="ui-icon" aria-hidden />
      <span className="topbar-title">{title}</span>
    </button>
  );
}

export default function TopBar({ right }: { right: ReactNode }) {
  const scrolled = useHeaderScrolled();
  const left = useRef<HTMLDivElement>(null);
  // Before paint, not after: the slot carries whatever the screen has already published, so
  // attaching it in a passive effect would show one frame of an empty left track.
  useLayoutEffect(() => {
    const node = leftSlot();
    if (node) left.current?.appendChild(node);
  }, []);
  return (
    <header className={scrolled ? 'topbar scrolled' : 'topbar'}>
      <div className="topbar-inner">
        <div ref={left} className="topbar-left" />
        <div className="topbar-right">{right}</div>
      </div>
    </header>
  );
}
