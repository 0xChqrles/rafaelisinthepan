import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import PlusIcon from '../assets/icons/plus.svg?react';
import { t } from '../i18n';
import type { LangCode } from '../langs';

// WHICH BOARD (#271, user-decided 2026-09-14 — the third design of this control, after a
// strip of named tabs and a chip opening a wheel: "it's weird to have the header wheel
// just above the group wheel… come up with a totally new leaderboard control design").
//
// The board's SCOPES — every group the player is in, then GLOBAL — are PAGES
// on one horizontal line, and the head of the screen is a PAGER through them: the page in
// the middle names what the list below shows, its neighbours peek in from the sides at a
// quarter strength, and a row of DOTS under it says where in the line you are (the active
// dot drawn long — the carousel grammar of the user's own reference, `inspiration/modern`).
// The middle page wears the app's CORNER BRACKETS, the device frame's selection mark:
// this is the framed one, and tapping it goes INTO it (the group's own screen).
//
// A SWIPE turns it — native scroll-snap, so the physics are the platform's own (momentum,
// the rubber ends, the snap) and nothing is re-implemented — and so do a tap on a peeking
// neighbour, a tap on a dot, and the arrow keys. Which page is in the middle is read off
// the scroll position (the nearest page centre to the pager's centre), LIVE for the
// dress and SETTLED (a short quiet after the last scroll event) for the caller, so a
// swipe across three groups fetches one board, not three.
//
// The pager is the ONE control: there is no chip, no wheel and no tab strip left on the
// board, and the period switch under it is the only other thing before the list. CREATING
// a group is the PLUS after the last dot (user-decided 2026-09-14: a NEW GROUP page wore
// the title's dress on what is a button — "feels like bad UX").
export interface Scope {
  key: string;
  title: string;
  // The small line under the title: a group's size, GLOBAL's "TOP 50". None on NEW.
  sub?: string;
}

const SETTLE_MS = 90;

export default function ScopePager({
  lang,
  scopes,
  active,
  onChange,
  onOpen,
  onNew,
}: {
  lang: LangCode;
  scopes: readonly Scope[];
  // The page the caller holds in the middle. Changing it from outside (a group created,
  // a group left) glides the pager there.
  active: number;
  // The page that settled in the middle, when it is not `active`.
  onChange: (index: number) => void;
  // A tap on the middle page.
  onOpen: (index: number) => void;
  // The plus after the dots.
  onNew: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  // The page nearest the middle RIGHT NOW (the dress follows it as the finger moves).
  const [near, setNear] = useState(active);
  const settle = useRef(0);
  const raf = useRef(0);

  // A page's centre, in the pager's own scroll coordinates. Measured through the rects,
  // never `offsetLeft`: the pager is not positioned, so that would be relative to the
  // centred column's offset parent — 425px off on a desktop, one page over.
  const centreOf = (el: HTMLElement, page: HTMLElement) => {
    const rect = page.getBoundingClientRect();
    return rect.left - el.getBoundingClientRect().left + el.scrollLeft + rect.width / 2;
  };

  const nearest = () => {
    const el = box.current;
    if (!el) return active;
    const mid = el.scrollLeft + el.clientWidth / 2;
    let best = 0;
    let bestDist = Infinity;
    Array.from(el.children).forEach((child, i) => {
      const dist = Math.abs(centreOf(el, child as HTMLElement) - mid);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    return best;
  };

  const scrollTo = (index: number, behavior: ScrollBehavior) => {
    const el = box.current;
    const page = el?.children[index] as HTMLElement | undefined;
    if (!el || !page) return;
    el.scrollTo({ left: centreOf(el, page) - el.clientWidth / 2, behavior });
  };

  // Open ON the held page, before paint; glide there when the caller moves it later —
  // and re-centre it, instantly, whenever the pager's own width changes (the column
  // settling on a desktop, a rotation): a snapped position is a fraction of a width.
  const mounted = useRef(false);
  useLayoutEffect(() => {
    scrollTo(active, mounted.current ? 'smooth' : 'instant');
    mounted.current = true;
    setNear(active);
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => scrollTo(active, 'instant'));
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, scopes.length]);

  useEffect(
    () => () => {
      window.clearTimeout(settle.current);
      cancelAnimationFrame(raf.current);
    },
    [],
  );

  const onScroll = () => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => setNear(nearest()));
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => {
      const index = nearest();
      if (index !== active) onChange(index);
    }, SETTLE_MS);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const index = Math.min(scopes.length - 1, Math.max(0, active + (e.key === 'ArrowRight' ? 1 : -1)));
    if (index !== active) onChange(index);
  };

  return (
    <div className="scope" onKeyDown={onKeyDown}>
      <div className="scope-pager" ref={box} onScroll={onScroll}>
        {scopes.map((scope, i) => {
          const on = i === near;
          return (
            <button
              key={scope.key}
              type="button"
              className={`scope-page${on ? ' on' : ''}`}
              // The middle page is the pager's one tab stop; the arrows turn it.
              tabIndex={i === active ? 0 : -1}
              aria-current={i === active ? 'true' : undefined}
              aria-label={scope.sub ? `${scope.title}, ${scope.sub}` : scope.title}
              onClick={() => (i === active ? onOpen(i) : onChange(i))}
            >
              <span className="scope-title" data-focus-box>
                {scope.title}
                {on && (
                  <>
                    <i className="scope-corner tl" aria-hidden />
                    <i className="scope-corner tr" aria-hidden />
                    <i className="scope-corner bl" aria-hidden />
                    <i className="scope-corner br" aria-hidden />
                  </>
                )}
              </span>
              {scope.sub && <span className="scope-sub">{scope.sub}</span>}
            </button>
          );
        })}
      </div>
      <div className="scope-dots" role="tablist" aria-label={t(lang, 'ariaLeaderboard')}>
        {scopes.map((scope, i) => (
          <button
            key={scope.key}
            type="button"
            role="tab"
            aria-selected={i === active}
            aria-label={scope.title}
            tabIndex={-1}
            className={`scope-dot${i === near ? ' on' : ''}`}
            onClick={() => onChange(i)}
          />
        ))}
        <button type="button" className="scope-add" aria-label={t(lang, 'groupNew')} onClick={onNew}>
          <PlusIcon className="ui-icon" aria-hidden />
        </button>
      </div>
    </div>
  );
}
