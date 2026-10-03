import { useCallback, useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import PlusIcon from '../assets/icons/plus.svg?react';
import { prefersReducedMotion } from '../hooks/useScramble';

// WHICH BOARD: the boards' ONE control across the app — the solved screen's boards and the
// board screen both turn through it. The scopes are NAMES IN A ROW (each group, then GLOBAL),
// `--ui` bold tracked capitals in the secondary ink, the one shown wearing the WHITE TITLE
// CHIP (the cards' one emphasis gesture).
//
// GLOBAL IS PINNED (`pinned`): the one tab every player has stays at the row's end whatever
// the groups' names add up to — sticky on the row's own axis, the groups passing UNDER it.
// Where everything fits it is simply the last name.
//
// ONLY WHOLE NAMES SHOW. Where the groups run past the column the row scrolls on its own axis
// (snapping to names), and a name the column cuts is not drawn cut, nor thinned to a few stray
// cells: it is COVERED, and the cover carries the boards' own mark for what is left out — the
// stippled rail of the rows a board leaves out (`.board-gap`) — at that end. Turning to a tab
// scrolls its name whole into view; a swipe of the row lets names in whole, a step at a time.
//
// THE CHIP TRAVELS. It is not a class on the shown name but ONE white sheet over the whole
// row, carrying the row's names again in the ground's ink (the pinned one pinned too),
// clipped to the shown name's box — so a turn moves the clip from one name to the next and
// the white block slides along the row, inverting exactly the letters it covers on the way.
// It moves in whole pixels and HARD STEPS (TRAVEL_STEPS over TRAVEL_MS, eased out), the
// house's motion; under reduced motion it is simply there. Its first drawing — the chip WIPED
// across the name — is each surface's CSS, timed to its own beat. A `bare` tab is a STATE, not
// a name (the board screen's "no group"): shown, it wears no chip — a white chip would make it
// a group of that name — only the plain ink.
//
// A ROVING TABLIST for the keyboard: Tab lands on the shown name alone; the arrow keys (and
// Home / End) move the focus AND turn, and a name taking the focus scrolls whole into view. A
// tap on another name turns to it; a tap (or Enter) on the SHOWN chip goes INTO it (`onOpen`:
// the result opens that board; the board screen opens a group's own screen). The board screen
// pins the PLUS at the row's end (`onNew`): creating a group is the row's one other act, and
// pinned it never scrolls out of reach.
export interface BoardTab {
  key: string;
  label: string;
  pinned?: boolean;
  bare?: boolean;
}

const TRAVEL_MS = 200;
const TRAVEL_STEPS = 6;
// The chip's band: a 24px chip in a 44px tab.
const CHIP_INSET_Y = 10;
// Where a name rests when the row is scrolled: this far in from the row's start (the snap's
// own padding, `.board-tabs-row`), leaving the left-out mark its room — and the room kept for
// that mark before the pinned name when names run on past it.
const MARK_ROOM_PX = 24;

type Chip = { l: number; r: number };

export default function BoardTabs({
  tabs,
  shown,
  onTurn,
  onOpen,
  onNew,
  newLabel,
  className = '',
}: {
  tabs: readonly BoardTab[];
  shown: number;
  onTurn: (index: number) => void;
  onOpen: (index: number) => void;
  // The pinned plus, and its accessible name.
  onNew?: () => void;
  newLabel?: string;
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const inkRef = useRef<HTMLDivElement>(null);
  const chip = useRef<Chip | null>(null);
  const travel = useRef<Animation | null>(null);
  const bare = tabs[shown]?.bare === true;
  const pin = tabs.findIndex((tab) => tab.pinned);

  const button = (index: number) => lineRef.current?.children[index] as HTMLElement | undefined;

  // THE CHIP: measured off the shown name's box in the line's own coordinates — read off the
  // rendered boxes, so a pinned name held at the row's end is measured where it stands —
  // written as the clip's two insets, and, when it was somewhere else, travelled there.
  // `animate` is false for a re-measure (the web font landing, the column resizing, the row
  // scrolling under a pinned chip): the chip is simply re-seated. Off a bare tab it has
  // nowhere to travel from: it is drawn in afresh.
  const seat = useCallback(
    (animate: boolean) => {
      const line = lineRef.current;
      const ink = inkRef.current;
      const label = line?.children[shown]?.firstElementChild as HTMLElement | null | undefined;
      if (!line || !ink || !label) return;
      const box = line.getBoundingClientRect();
      const at = label.getBoundingClientRect();
      const next = { l: Math.round(at.left - box.left), r: Math.round(box.right - at.right) };
      const prev = chip.current;
      chip.current = bare ? null : next;
      ink.style.setProperty('--chip-l', `${next.l}px`);
      ink.style.setProperty('--chip-r', `${next.r}px`);
      if (bare || !animate || prev === null || (prev.l === next.l && prev.r === next.r) || prefersReducedMotion()) return;
      travel.current?.cancel();
      const frames: Keyframe[] = [];
      for (let k = 0; k <= TRAVEL_STEPS; k += 1) {
        const t = k / TRAVEL_STEPS;
        const e = 1 - (1 - t) * (1 - t);
        const l = Math.round(prev.l + (next.l - prev.l) * e);
        const r = Math.round(prev.r + (next.r - prev.r) * e);
        frames.push({ clipPath: `inset(${CHIP_INSET_Y}px ${r}px ${CHIP_INSET_Y}px ${l}px)`, offset: t, easing: 'steps(1, end)' });
      }
      travel.current = ink.animate(frames, { duration: TRAVEL_MS });
    },
    [shown, bare],
  );

  // THE COVERS: at each end, from the row's edge to the nearest WHOLE name (the label's box —
  // the chip's), drawn only when a name is left out there; at the far end the pinned name is
  // the edge. Written straight onto the control's style (a scroll frame re-renders nothing).
  const cover = useCallback(() => {
    const root = rootRef.current;
    const row = rowRef.current;
    const line = lineRef.current;
    if (!root || !row || !line) return;
    const box = row.getBoundingClientRect();
    const pinned = pin >= 0 ? (line.children[pin]?.firstElementChild as HTMLElement | null) : null;
    const end = pinned ? pinned.getBoundingClientRect().left - box.left : box.width;
    let first = Infinity;
    let last = -Infinity;
    let cutLeft = false;
    let cutRight = false;
    for (let i = 0; i < tabs.length; i += 1) {
      const label = line.children[i]?.firstElementChild;
      if (i === pin || !label) continue;
      const at = label.getBoundingClientRect();
      const l = at.left - box.left;
      const r = at.right - box.left;
      if (l < -0.5) cutLeft = true;
      else if (r > end + 0.5) cutRight = true;
      else {
        first = Math.min(first, l);
        last = Math.max(last, r);
      }
    }
    root.style.setProperty('--cover-l', cutLeft && first < Infinity ? `${Math.round(first)}px` : '0px');
    root.style.setProperty('--cover-r-x', `${Math.round(last > -Infinity ? last : 0)}px`);
    root.style.setProperty('--cover-r', cutRight ? `${Math.max(0, Math.round(end - (last > -Infinity ? last : 0)))}px` : '0px');
    root.toggleAttribute('data-cut-l', cutLeft);
    root.toggleAttribute('data-cut-r', cutRight);
  }, [pin, tabs.length]);

  const onScroll = useCallback(() => {
    cover();
    // A pinned chip moves with the row's scroll (it is held while the line slides).
    if (shown === pin) seat(false);
  }, [cover, seat, shown, pin]);

  const keys = tabs.map((tab) => `${tab.key}:${tab.label}`).join(' ');
  useLayoutEffect(() => {
    seat(true);
    cover();
  }, [seat, cover, keys]);
  // A name's width moves when the web font lands, and the row's with the column: re-seat.
  useEffect(() => {
    const row = rowRef.current;
    const line = lineRef.current;
    if (!row || !line || typeof ResizeObserver === 'undefined') return undefined;
    onScroll();
    const ro = new ResizeObserver(() => {
      onScroll();
      seat(false);
    });
    ro.observe(row);
    ro.observe(line);
    return () => ro.disconnect();
  }, [onScroll, seat, keys]);
  useEffect(() => () => travel.current?.cancel(), []);

  // A NAME STAYS WHOLE IN VIEW: the row scrolls (on its own axis only) the least it takes to
  // show it entire, clear of the left-out mark's room at either end (the snap's own padding;
  // before the pinned name, unless nothing but the pinned name follows). The pinned name is
  // always in view.
  const reveal = useCallback(
    (index: number) => {
      const row = rowRef.current;
      const line = lineRef.current;
      const tab = button(index);
      if (!row || !line || !tab || tabs[index]?.pinned) return;
      // The name's own box — the label, the chip's — in the line's terms (the tab's padding
      // round it is ground, and may sit under a cover).
      const origin = line.getBoundingClientRect().left;
      const box = (tab.firstElementChild ?? tab).getBoundingClientRect();
      const left = box.left - origin;
      const right = box.right - origin;
      // What the far end keeps: the pinned name from its label on (held at the row's end
      // whatever the scroll), and the left-out mark's room before it unless this is the last
      // name before it.
      const pinned = pin >= 0 ? button(pin) : undefined;
      const held = pinned ? pinned.getBoundingClientRect().right - (pinned.firstElementChild ?? pinned).getBoundingClientRect().left : 0;
      const last = tabs.reduce((at, t, i) => (t.pinned ? at : i), -1);
      const tail = held + (index < last ? MARK_ROOM_PX : 0);
      const from = row.scrollLeft + (row.scrollLeft > 1 ? MARK_ROOM_PX : 0);
      const to = row.scrollLeft + row.clientWidth - tail;
      // The snap positions: each name's tab start behind the mark's room (the first, the row's).
      const snap = (i: number) => (i === 0 ? 0 : Math.max(0, (button(i)?.offsetLeft ?? 0) - MARK_ROOM_PX));
      const own = snap(index);
      let target: number | null = null;
      if (left < from) target = own;
      else if (right > to) {
        // The least scroll that shows it, moved on to the next snap position — never past the
        // name's own start: a name longer than the room shows its start.
        const least = right - (row.clientWidth - tail);
        const next = tabs.map((t, i) => (t.pinned ? Infinity : snap(i))).find((start) => start >= least);
        target = Math.min(own, next ?? own);
      }
      if (target !== null && Math.abs(target - row.scrollLeft) > 0.5) {
        row.scrollTo({ left: target, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      }
    },
    // `keys` stands for `tabs`: the tabs' content, not the array a parent re-creates.
    [keys, pin],
  );
  useEffect(() => reveal(shown), [reveal, shown]);

  const onKeyDown = (e: KeyboardEvent) => {
    const from = Array.from(lineRef.current?.children ?? []).indexOf(document.activeElement as Element);
    if (from < 0 || from >= tabs.length) return;
    const next =
      e.key === 'ArrowRight'
        ? Math.min(tabs.length - 1, from + 1)
        : e.key === 'ArrowLeft'
          ? Math.max(0, from - 1)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? tabs.length - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    button(next)?.focus({ preventScroll: true });
    if (next !== shown) onTurn(next);
  };

  return (
    <div ref={rootRef} className={`board-tabs ${className}`}>
      <div ref={rowRef} className="board-tabs-row" onScroll={onScroll}>
        <div ref={lineRef} className="board-tabs-line" role="tablist" aria-orientation="horizontal" onKeyDown={onKeyDown}>
          {tabs.map((tab, i) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              className={`board-tab${i === shown ? ' on' : ''}${tab.pinned ? ' pinned' : ''}${tab.bare ? ' bare' : ''}`}
              aria-selected={i === shown}
              tabIndex={i === shown ? 0 : -1}
              onFocus={() => reveal(i)}
              onClick={() => (i === shown ? onOpen(i) : onTurn(i))}
            >
              <span className="board-tab-label" data-focus-box>
                {tab.label}
              </span>
            </button>
          ))}
          {/* THE CHIP: the row again, in the ground's ink on white, clipped to the shown
              name (see the header). */}
          {tabs.length > 0 && (
            <div ref={inkRef} className={`board-tabs-ink${bare ? ' bare' : ''}`} aria-hidden="true">
              {tabs.map((tab) => (
                <span key={tab.key} className={`board-tab${tab.pinned ? ' pinned' : ''}`}>
                  <span className="board-tab-label">{tab.label}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      {/* The names left out, one cover each end (see the header). */}
      <span className="board-tabs-cover l" aria-hidden="true" />
      <span className="board-tabs-cover r" aria-hidden="true" />
      {onNew && (
        <button type="button" className="board-tabs-new" aria-label={newLabel} onClick={onNew}>
          <PlusIcon className="ui-icon" aria-hidden />
        </button>
      )}
    </div>
  );
}
