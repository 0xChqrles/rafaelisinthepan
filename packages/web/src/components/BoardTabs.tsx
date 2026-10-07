import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { UI_ADVANCE_EM } from '@whippin/shared';
import { SKELETON_WAIT_MS } from './bayerTiles';
import { travelFrames } from './travel';
import PlusIcon from '../assets/icons/plus.svg?react';
import { prefersReducedMotion } from '../hooks/useScramble';

// WHICH BOARD: the boards' ONE control across the app — the solved screen's boards and the
// board screen both turn through it, and so does the archive's month (a selection among
// months, the active one pinned: `calendar/months.ts`). The tabs are NAMES IN A ROW (each
// group, then GLOBAL), `--ui` bold tracked capitals in the secondary ink, the one shown
// wearing the WHITE TITLE CHIP (the cards' one emphasis gesture).
//
// GLOBAL IS PINNED (`pinned`): the one tab every player has stays at the row's end whatever
// the groups' names add up to — sticky on the row's own axis, the groups passing UNDER it.
// Where everything fits it is simply the last name. Where names are left out before it, it
// FOLLOWS THE LEFT-OUT RAIL DIRECTLY — drawn in from the row's end to stand just past the rail
// (`--pin-shift`, the ground carried on after it to the row's end), so the row reads as whole
// names, the rail, GLOBAL, and the ground after it, never a band of nothing between the rail
// and GLOBAL. Where it stands is decided only for a row AT REST — on layout, on a resize, once
// a scroll has settled, and on a turn for where the turn's scroll will rest — and it HOLDS
// there while the row moves: the names pass under it and it never slides with them, taking
// its new place in one step.
//
// ONLY WHOLE NAMES SHOW. Where the groups run past the column the row scrolls on its own axis
// (snapping to names), and a name the column cuts is not drawn cut, nor thinned to a few stray
// cells: it is COVERED, and the cover carries the boards' own mark for what is left out — the
// stippled rail of the rows a board leaves out (`.board-gap`) — at that end, against the whole
// name next to it, on whole pixels. A cover too narrow to hold its mark takes the next whole
// name too (left out with the rest) — never the shown one, so a cover against the shown name
// can stand unmarked. Turning to a tab scrolls its name whole into view; a swipe of the row
// lets names in whole, a step at a time. A name too long to show whole in the room the row
// leaves it, scrolled to (clear of the left-out marks and of the pinned name), ENDS IN AN
// ELLIPSIS at that room — so the shown name is always there to read, never under a cover.
//
// THE CHIP TRAVELS. It is not a class on the shown name but ONE white sheet over the whole
// row, carrying the row's names again in the ground's ink (the pinned one pinned too),
// clipped to the shown name's box — so a turn moves the clip from one name to the next and
// the white block slides along the row, inverting exactly the letters it covers on the way.
// It travels only on a turn (the shown tab changing): names added or resized round it re-seat
// it in place. It moves in whole pixels and HARD STEPS (TRAVEL_STEPS over TRAVEL_MS, eased
// out), the house's motion; under reduced motion it is simply there. Its first drawing — the
// chip WIPED across the name — is each surface's CSS, timed to its own beat. A `bare` tab is a
// STATE, not a name (the board screen's "no group"): shown, it wears no chip — a white chip
// would make it a group of that name — only the plain ink.
//
// A ROVING TABLIST for the keyboard: Tab lands on the shown name alone; the arrow keys (and
// Home / End) move the focus AND turn, and a name taking the focus scrolls whole into view. A
// tap on another name turns to it; a tap (or Enter) on the SHOWN chip goes INTO it (`onOpen`:
// the result opens that board; the board screen opens a group's own screen; the archive's
// shown month goes nowhere, and passes none). The board screen pins the PLUS at the row's end
// (`onNew`): creating a group is the row's one other act, and pinned it never scrolls out of
// reach. Each tab names the PANEL it controls — the surface's board, which takes its name from
// the shown tab (`tabIds`, off one id the surface owns).
//
// WHILE THE NAMES ARE UNKNOWN (no tabs yet: the groups' list still out, or failed), the row
// HOLDS ITS ROOM with ONE CHIP in the house hold where the shown chip will stand (`hold`): the
// slate stippled through the Bayer tiles at the chip's 24px, breathing while the read is out —
// and in only once it has been out SKELETON_WAIT_MS, so a quick one never flashes it — still
// once it has failed. A chip once drawn stays drawn: a RETRY's read breathes it at once, never
// out for another wait. Only its width is a guess. The names then take the row, the chip wiped
// across the shown one on each surface's own beat.
export const tabIds = (base: string) => ({ panel: `${base}panel`, tab: (key: string) => `${base}tab-${key}` });
export interface BoardTabItem {
  key: string;
  label: string;
  pinned?: boolean;
  bare?: boolean;
  // What a reader hears for the tab, where its label is a short form (the archive's month
  // names: `SEPT` is read "septembre 2026").
  ariaLabel?: string;
}

const TRAVEL_MS = 200;
const TRAVEL_STEPS = 6;
// The chip's band: a 24px chip in a 44px tab.
const CHIP_INSET_Y = 10;
// Where a name rests when the row is scrolled: this far in from the row's start (the snap's
// own padding, `.board-tabs-row`), leaving the left-out mark its room — and the room kept for
// that mark before the pinned name when names run on past it.
const MARK_ROOM_PX = 24;
// A tab's padding each side of its name (`.board-tab`), and the least cover that holds the
// left-out mark (its 14px, 10px from the whole name it stands against).
const TAB_PAD_PX = 4;
const COVER_MARK_PX = 24;
// Where the pinned name stands when names are left out before it: the mark's room, and the
// mark's own 10px of air on its far side too.
const PIN_AFTER_PX = COVER_MARK_PX + 10;
// A row is AT REST once this long has passed with no scroll frame and no finger on it (iOS
// Safari has no `scrollend`; a momentum scroll and a snap send a frame every frame).
const REST_MS = 150;
// A name's label (`.board-tab-label`): its padding each side, and a glyph's advance — the
// mono's at 14px, tracked 0.08em.
const LABEL_PAD_PX = 7;
const GLYPH_PX = 14 * (UI_ADVANCE_EM + 0.08);

type Chip = { l: number; r: number };
type Names = { whole: { l: number; r: number; shown: boolean }[]; cutLeft: boolean; cutRight: boolean; a: number; b: number };

export default function BoardTabs({
  tabs,
  shown,
  onTurn,
  onOpen,
  onNew,
  newLabel,
  idBase,
  hold = 'waiting',
}: {
  tabs: readonly BoardTabItem[];
  // What the empty row says (see the header): a read still out, or one that failed.
  hold?: 'waiting' | 'failed';
  shown: number;
  // The surface's id for the tabs and their panel (`tabIds`).
  idBase: string;
  onTurn: (index: number) => void;
  onOpen?: (index: number) => void;
  // The pinned plus, and its accessible name.
  onNew?: () => void;
  newLabel?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const inkRef = useRef<HTMLDivElement>(null);
  const chip = useRef<Chip | null>(null);
  // The tab the chip was last seated on (its key): the chip travels only when that changes.
  const chipOn = useRef<string | null>(null);
  const travel = useRef<Animation | null>(null);
  // How far the pinned name stands drawn in from the row's end — decided at rest, held while
  // the row moves — and the rest's own clock: the timer, and a finger still on the row.
  const shift = useRef(0);
  const restTimer = useRef<number | undefined>(undefined);
  const touching = useRef(false);
  const bare = tabs[shown]?.bare === true;
  const pin = tabs.findIndex((tab) => tab.pinned);
  // Whether the hold has been DRAWN in this wait (a failed read stands it still): the read a
  // retry sends then breathes it at once — coming in late again would blink it out for the wait.
  const holding = tabs.length === 0;
  const [drawn, setDrawn] = useState(false);
  const drawnNow = holding && (drawn || hold === 'failed');
  if (drawnNow !== drawn) setDrawn(drawnNow);

  const button = (index: number) => lineRef.current?.children[index] as HTMLElement | undefined;
  const keys = tabs.map((tab) => `${tab.key}:${tab.label}`).join(' ');

  // THE CHIP: measured off the shown name's box in the line's own coordinates — read off the
  // rendered boxes, so a pinned name held at the row's end is measured where it stands —
  // written as the clip's two insets, and, when it was on another tab, travelled there.
  // `animate` is false for a re-measure (the web font landing, the column resizing, the row
  // scrolling under a pinned chip): the chip is simply re-seated — as it is when the tab it is
  // on stays and the names round it change (a month added at 22:00, a group appended). Off a
  // bare tab it has nowhere to travel from: it is drawn in afresh.
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
      const on = tabs[shown]?.key ?? null;
      const turned = chipOn.current !== on;
      chip.current = bare ? null : next;
      chipOn.current = on;
      ink.style.setProperty('--chip-l', `${next.l}px`);
      ink.style.setProperty('--chip-r', `${next.r}px`);
      const still = prev === null || (prev.l === next.l && prev.r === next.r);
      if (bare || !animate || !turned || still || prefersReducedMotion()) return;
      travel.current?.cancel();
      const frames = travelFrames(TRAVEL_STEPS, (e) => {
        const l = Math.round(prev.l + (next.l - prev.l) * e);
        const r = Math.round(prev.r + (next.r - prev.r) * e);
        return { clipPath: `inset(${CHIP_INSET_Y}px ${r}px ${CHIP_INSET_Y}px ${l}px)` };
      });
      travel.current = ink.animate(frames, { duration: TRAVEL_MS });
    },
    // `keys` stands for `tabs`: the tabs' content, not the array a parent re-creates.
    [shown, bare, keys],
  );

  // EACH NAME'S ROOM: the most it can show whole once scrolled to (`--label-max`, on the name and
  // on its copy on the chip's sheet), floored to whole glyphs — so a name cut there ends its
  // ellipsis one padding short of the chip's edge, as it starts one padding in. Written straight
  // onto the names' style when the row's width or its names change (never on a scroll: it does
  // not move with one).
  const caps = useCallback(() => {
    const row = rowRef.current;
    const line = lineRef.current;
    const ink = inkRef.current;
    if (!row || !line) return;
    const pinnedTab = pin >= 0 ? button(pin) : undefined;
    const held = pinnedTab ? pinnedTab.offsetWidth - TAB_PAD_PX : 0;
    const lastName = tabs.reduce((at, t, i) => (t.pinned ? at : i), -1);
    for (let i = 0; i < tabs.length; i += 1) {
      if (i === pin) continue;
      // Scrolled to, a name stands past the left-out mark's room (the first, at the row's start)
      // and ends before the pinned name and, unless it is the last, the mark's room before it.
      const room =
        row.clientWidth - held - (i < lastName ? MARK_ROOM_PX : 0) - (i > 0 ? MARK_ROOM_PX : 0) - TAB_PAD_PX;
      const glyphs = Math.max(0, Math.floor((room - 2 * LABEL_PAD_PX) / GLYPH_PX));
      for (const el of [line.children[i], ink?.children[i]]) {
        (el as HTMLElement | undefined)?.style.setProperty(
          '--label-max',
          `${Math.ceil(2 * LABEL_PAD_PX + glyphs * GLYPH_PX)}px`,
        );
      }
    }
    // `keys` stands for `tabs`: the tabs' content, not the array a parent re-creates.
  }, [pin, keys]);

  // THE NAMES IN VIEW against an end (in the row's own coordinates), the row taken `ahead` px
  // on from where it stands: the whole names in row order, whether one is cut at either end,
  // and the run the covers stop at (`a`..`b`: a cover too narrow for the mark takes the next
  // whole name too, and so on). The SHOWN name counts as whole wherever it is at least partly
  // in view (it is scrolled to, and its room capped above), so a cover stops short of it —
  // but one a swipe has taken wholly out of view is left out like any other.
  const names = useCallback(
    (end: number, ahead: number): Names | null => {
      const row = rowRef.current;
      const line = lineRef.current;
      if (!row || !line) return null;
      // (A row scrolled `ahead` px on carries every name that far left.)
      const origin = row.getBoundingClientRect().left + ahead;
      const whole: Names['whole'] = [];
      let cutLeft = false;
      let cutRight = false;
      for (let i = 0; i < tabs.length; i += 1) {
        const label = line.children[i]?.firstElementChild;
        if (i === pin || !label) continue;
        const at = label.getBoundingClientRect();
        const l = at.left - origin;
        const r = at.right - origin;
        if (i === shown && r > 0.5 && l < end - 0.5) whole.push({ l: Math.max(0, l), r: Math.min(end, r), shown: true });
        else if (l < -0.5) cutLeft = true;
        else if (r > end + 0.5) cutRight = true;
        else whole.push({ l, r, shown: false });
      }
      let a = 0;
      let b = whole.length - 1;
      if (cutLeft) while (a < b && !whole[a].shown && whole[a].l < COVER_MARK_PX) a += 1;
      if (cutRight) while (b > a && !whole[b].shown && end - whole[b].r < COVER_MARK_PX) b -= 1;
      return { whole, cutLeft, cutRight, a, b };
    },
    // `keys` stands for `tabs`: the tabs' content, not the array a parent re-creates.
    [pin, keys, shown],
  );

  // Where the pinned name RESTS undrawn: the row's end less its own width (never its drawn
  // place, which the shift moves).
  const restEnd = useCallback(() => {
    const row = rowRef.current;
    const pinnedTab = pin >= 0 ? button(pin) : undefined;
    if (!row) return 0;
    const width = row.getBoundingClientRect().width;
    return pinnedTab ? width - pinnedTab.offsetWidth + TAB_PAD_PX : width;
  }, [pin]);

  // GLOBAL DRAWN IN for the row at rest — where it stands, or `ahead` px on, where a turn's
  // scroll will rest: `PIN_AFTER_PX` past the last whole name when names are left out before
  // it, else at the row's end; the ground carried on after it to the row's end. Never on a
  // scroll frame.
  const drawIn = useCallback(
    (ahead: number) => {
      const root = rootRef.current;
      const row = rowRef.current;
      if (!root || !row) return;
      let next = 0;
      if (pin >= 0) {
        const end = restEnd();
        const seen = names(end, ahead);
        const last = seen && seen.b >= 0 ? seen.whole[seen.b].r : 0;
        if (seen?.cutRight) next = Math.max(0, Math.floor(end - last - PIN_AFTER_PX));
      }
      // (A name's box lands a pixel either way of its place from one rest to the next: the
      // pinned name does not step for that.)
      if (next > 0 && shift.current > 0 && Math.abs(next - shift.current) <= 1) next = shift.current;
      shift.current = next;
      root.style.setProperty('--pin-shift', `${next}px`);
      root.style.setProperty('--pin-ground-x', `${Math.round(row.getBoundingClientRect().width - next)}px`);
    },
    [pin, names, restEnd],
  );

  // THE COVERS: at each end, from the row's edge to the nearest WHOLE name (the label's box —
  // the chip's), drawn only when a name is left out there; at the far end the pinned name is
  // the edge, where it STANDS (drawn in, and held there while the row moves). Every scroll
  // frame, written straight onto the control's style (a scroll frame re-renders nothing).
  const cover = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const end = restEnd() - shift.current;
    const seen = names(end, 0);
    if (!seen) return;
    const { whole, cutLeft, cutRight, a, b } = seen;
    const last = b >= 0 ? whole[b].r : 0;
    const coverL = cutLeft && a <= b ? Math.round(whole[a].l) : 0;
    const coverR = cutRight ? Math.max(0, Math.round(end - last)) : 0;
    root.style.setProperty('--cover-l', `${coverL}px`);
    root.style.setProperty('--cover-r-x', `${Math.round(last)}px`);
    root.style.setProperty('--cover-r', `${coverR}px`);
    root.toggleAttribute('data-cut-l', cutLeft);
    root.toggleAttribute('data-cut-r', cutRight);
    // The mark only where the cover holds it whole, clear of the names round it.
    root.toggleAttribute('data-mark-l', coverL >= COVER_MARK_PX);
    root.toggleAttribute('data-mark-r', coverR >= COVER_MARK_PX);
  }, [names, restEnd]);

  // AT REST: the pinned name drawn in afresh, the covers against it, and a pinned chip
  // re-seated (it stands on the pinned name) — only once it STANDS there: a turn to the pinned
  // name settles before its chip has travelled, and seating it then would land it in one frame.
  const settle = useCallback(() => {
    drawIn(0);
    cover();
    if (shown === pin && chipOn.current === tabs[pin]?.key) seat(false);
    // `keys` stands for `tabs`: the tabs' content, not the array a parent re-creates.
  }, [drawIn, cover, seat, shown, pin, keys]);
  // The rest reads the row as it stands WHEN IT COMES, never as it stood when it was armed: a
  // tap's lift arms it before the tap's click turns the tab, and the settle of that earlier
  // render would seat the chip back on the tab turned from.
  const settleNow = useRef(settle);
  settleNow.current = settle;

  // THE ROW MOVES from a scroll's first frame (or a turn's scroll asked for) until `REST_MS`
  // pass with no frame and no finger on it. Anything measured meanwhile — a resize, a turn —
  // re-covers only; the rest draws the pinned name in.
  const armRest = useCallback(() => {
    window.clearTimeout(restTimer.current);
    restTimer.current = window.setTimeout(() => {
      restTimer.current = undefined;
      // (A finger still down: its lift arms the rest again.)
      if (!touching.current) settleNow.current();
    }, REST_MS);
  }, []);
  const refresh = useCallback(() => {
    if (restTimer.current !== undefined || touching.current) cover();
    else settle();
  }, [cover, settle]);

  // A scroll frame moves the covers alone (and a pinned chip, held while the line slides).
  const onScroll = useCallback(() => {
    cover();
    if (shown === pin) seat(false);
    armRest();
  }, [cover, seat, armRest, shown, pin]);
  const onTouch = (down: boolean) => {
    touching.current = down;
    if (!down) armRest();
  };

  // (The names' room first: the covers and the chip are measured off it.)
  useLayoutEffect(() => {
    caps();
    refresh();
    seat(true);
  }, [seat, caps, refresh, keys]);
  // A name's width moves when the web font lands, and the row's with the column: re-seat.
  useEffect(() => {
    const row = rowRef.current;
    const line = lineRef.current;
    if (!row || !line || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      caps();
      refresh();
      seat(false);
    });
    ro.observe(row);
    ro.observe(line);
    return () => ro.disconnect();
  }, [caps, refresh, seat, keys]);
  useEffect(
    () => () => {
      travel.current?.cancel();
      window.clearTimeout(restTimer.current);
    },
    [],
  );

  // A NAME STAYS WHOLE IN VIEW: the row scrolls (on its own axis only) the least it takes to
  // show it entire, clear of the left-out mark's room at either end (the snap's own padding;
  // before the pinned name, unless nothing but the pinned name follows). The pinned name is
  // always in view. On a TURN (`turned`) the pinned name takes its place for where the row
  // will rest at once; on a focus alone it waits for the rest — a focus lands between a
  // tap's press and its click, and a name moved under the finger there takes the click.
  const reveal = useCallback(
    (index: number, turned: boolean) => {
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
      if (target === null) return;
      const ahead = Math.min(target, row.scrollWidth - row.clientWidth) - row.scrollLeft;
      if (Math.abs(ahead) <= 0.5) return;
      if (turned) {
        drawIn(ahead);
        cover();
      }
      row.scrollTo({ left: target, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      armRest();
    },
    // `keys` stands for `tabs`: the tabs' content, not the array a parent re-creates.
    [keys, pin, drawIn, cover, armRest],
  );
  // (A layout effect, after the one above: the pinned name's step and the turn land on the
  // same frame.)
  useLayoutEffect(() => reveal(shown, true), [reveal, shown]);

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
    <div ref={rootRef} className="board-tabs">
      <div
        ref={rowRef}
        className="board-tabs-row"
        onScroll={onScroll}
        onTouchStart={() => onTouch(true)}
        onTouchEnd={() => onTouch(false)}
        onTouchCancel={() => onTouch(false)}
      >
        <div ref={lineRef} className="board-tabs-line" role="tablist" aria-orientation="horizontal" onKeyDown={onKeyDown}>
          {holding && (
            <span
              className={`board-tabs-hold link-hold${hold === 'failed' ? ' still' : drawn ? ' waiting' : ' waiting late'}`}
              style={{ '--wait': `${SKELETON_WAIT_MS}ms` } as CSSProperties}
              aria-hidden="true"
            />
          )}
          {tabs.map((tab, i) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              id={tabIds(idBase).tab(tab.key)}
              aria-controls={tabIds(idBase).panel}
              aria-label={tab.ariaLabel}
              className={`board-tab${i === shown ? ' on' : ''}${tab.pinned ? ' pinned' : ''}${tab.bare ? ' bare' : ''}`}
              aria-selected={i === shown}
              tabIndex={i === shown ? 0 : -1}
              onFocus={() => reveal(i, false)}
              onClick={() => (i === shown ? onOpen?.(i) : onTurn(i))}
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
      {/* The names left out, one cover each end, and the ground after the pinned name drawn
          in (see the header). */}
      <span className="board-tabs-cover l" aria-hidden="true" />
      <span className="board-tabs-cover r" aria-hidden="true" />
      <span className="board-tabs-ground" aria-hidden="true" />
      {onNew && (
        <button type="button" className="board-tabs-new" aria-label={newLabel} onClick={onNew}>
          <PlusIcon className="ui-icon" aria-hidden />
        </button>
      )}
    </div>
  );
}
