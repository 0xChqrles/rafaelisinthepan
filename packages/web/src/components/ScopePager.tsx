import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import PlusIcon from '../assets/icons/plus.svg?react';
import { prefersReducedMotion } from '../hooks/useScramble';
import { t } from '../i18n';
import type { LangCode } from '../langs';

// WHICH BOARD (#271, user-decided 2026-09-14 — the third design of this control, after a
// strip of named tabs and a chip opening a wheel: "it's weird to have the header wheel
// just above the group wheel… come up with a totally new leaderboard control design").
//
// The board's SCOPES — every group the player is in, then GLOBAL — are PAGES
// on one horizontal line, and the head of the screen is a PAGER through them: the page in
// the middle names what the list below shows, a neighbour's first or last letters peek
// in at each edge at half strength, and a row of DOTS under it says where in the line
// you are (the active dot drawn long — the carousel grammar of the user's own reference,
// `inspiration/modern`). The middle page wears the app's CORNER BRACKETS, the device
// frame's selection mark: this is the framed one, and tapping it goes INTO it (the
// group's own screen).
//
// A PAGE IS THE LINE LESS A PEEK AT EACH END, and a neighbour's name LEANS against the
// edge its page shares with the middle one. User-reported 2026-09-14, twice: pages 60% of
// the line with every name centred left a short neighbour out past the edge ("it might
// not be obvious that you can swipe"); pages cut to their names' widths then packed the
// neighbours against the brackets ("the other groups names are too close to the current
// group name, they should only be on the side, and you should see part of one neighbour
// per side maximum"). Names differ in length, so no fixed spacing can put every
// neighbour's edge at the peek; the lean does, whatever the lengths: it follows the
// scroll, a name sliding from its page's inner edge to its centre as the page comes to
// the middle, so a swipe carries the peeking name into the brackets. The next page out
// sits a whole page further, past the edge. Only the middle page shows its caption.
//
// A SWIPE turns it — native scroll-snap, so the physics are the platform's own (momentum,
// the rubber ends, the snap) and nothing is re-implemented — and so do a tap on a
// neighbour, a tap on a dot, and the arrow keys. A swipe moves ONE page (the name peeking
// at the edge is where it lands); a dot glides as far as it names. Which page is in the
// middle is read off the scroll position (the nearest page centre to the pager's centre),
// LIVE for the dress and SETTLED (a short quiet after the last scroll event) for the
// caller, so a glide across three groups fetches one board, not three.
//
// The pager is the ONE control: there is no chip, no wheel and no tab strip left on the
// board, and the period switch under it is the only other thing before the list. CREATING
// a group is the PLUS after the last dot (user-decided 2026-09-14: a NEW GROUP page wore
// the title's dress on what is a button — "feels like bad UX").
export interface Scope {
  key: string;
  title: string;
  // The small line under the middle page's title: a group's size, GLOBAL's "TOP 50".
  // None on the no-group page.
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
  // The held page, for the resize observer, which outlives a page turn.
  const held = useRef(active);

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

  // THE LEAN, for the scroll position right now: a page's distance from the middle, in
  // pages and held to one, moves its name from the page's centre (0) to the page's edge
  // nearest the middle (±1) — the edge the peek shows. Every width is read before any
  // lean is written, so a frame lays out once.
  const place = () => {
    const el = box.current;
    if (!el) return;
    const mid = el.scrollLeft + el.clientWidth / 2;
    const pages = Array.from(el.children) as HTMLElement[];
    const leans = pages.map((page) => {
      const title = page.firstElementChild as HTMLElement | null;
      const width = page.getBoundingClientRect().width;
      if (!title || width === 0) return 0;
      const away = Math.max(-1, Math.min(1, (centreOf(el, page) - mid) / width));
      return Math.round((-away * (width - title.getBoundingClientRect().width)) / 2);
    });
    pages.forEach((page, i) => page.style.setProperty('--lean', `${leans[i]}px`));
  };

  // Open ON the held page, before paint; glide there when the caller moves it later (a
  // cut under reduced motion, the app's standing rule).
  const mounted = useRef(false);
  useLayoutEffect(() => {
    held.current = active;
    scrollTo(active, mounted.current && !prefersReducedMotion() ? 'smooth' : 'instant');
    mounted.current = true;
    setNear(active);
    place();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, scopes.length]);

  // RE-CENTRE the held page, instantly, when the pager's width CHANGES (the column
  // settling on a desktop, a rotation): a snapped position is a fraction of a width. Only
  // a CHANGE: an observer's first report of an element is its arrival, and answering that
  // one — the observer used to be rebuilt on every page turn — re-centred instantly and
  // cut short the glide just started above, so a tap on a dot jumped. The NAMES are
  // watched too, for the lean alone: a lean is measured off a name's width, which moves
  // when the web font lands.
  const pageKeys = scopes.map((scope) => scope.key).join(' ');
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    let width: number | undefined;
    const observer = new ResizeObserver((entries) => {
      const line = entries.find((entry) => entry.target === el);
      if (line) {
        if (width !== undefined && width !== line.contentRect.width) scrollTo(held.current, 'instant');
        width = line.contentRect.width;
      }
      place();
    });
    observer.observe(el);
    for (const page of Array.from(el.children)) {
      if (page.firstElementChild) observer.observe(page.firstElementChild);
    }
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKeys]);

  useEffect(
    () => () => {
      window.clearTimeout(settle.current);
      cancelAnimationFrame(raf.current);
    },
    [],
  );

  const onScroll = () => {
    place();
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
