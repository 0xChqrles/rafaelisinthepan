// THE RESULT'S BOARDS: under SHARE, how the player's day compares — each of their groups in
// turn, then GLOBAL — on the card's own BARE GROUND: no panel, no row boxes, lines of type set
// on the column. Each tab is a few of the board's own rows (`BoardRows`, dressed here as lines:
// the rank or the crown, the mark at 3px a cell, the name, the number in the pixel face; the
// player's own line FRAMED by the card's corner brackets, small; a member still playing with
// their % as the tries' exponent in the heat's ink; a round ended unsolved `∞`, muted), picked
// by `game/resultBoards.ts`: the whole day when it fits, else the podium, the player's ±1 and a
// few still playing, the box filled with the rows next in line, a stippled rail where rows are
// left out and a `+N` under them.
//
// THE TABS are the groups' NAMES in a row, the one shown wearing the white title chip — the
// share and group cards' one emphasis gesture — then GLOBAL; the row scrolls on its own axis
// where it runs past the column and thins out through an ordered dither there (the house's
// texture), never a guillotined name, and the name turned to scrolls whole into view. At its
// right edge, always in view, the PLUS: an empty group's slot (a dashed chip), the board
// screen's own NEW GROUP — where the player is looking at what a group gives them.
//
// The data is not this screen's to fetch twice: the groups come off the LIVE read the play
// screen already keeps (`state/liveBoard.ts`), passed in; GLOBAL is one anonymous read of the
// global board per mount (`useGlobalBoard`). The active day only — the caller mounts this for
// nothing else.
//
// ONE FIXED BOX, whatever it holds: empty while the first answers are out, the same height on
// every tab, so nothing that has landed moves when a read arrives or a swipe turns the page.
// It draws nothing until the GLOBAL read has answered too (a failure is an answer): the tabs
// and the rank column they share are decided together, and a global rank of three digits
// landing late would widen that column under a group's lines already shown.
// Its fate is decided ONCE, by the page under it: a box whose reads have all answered with
// nothing to show BEFORE the page lands leaves the stage's flow (the page has not shown, so
// nothing seen moves) and never comes back; once the page has landed — at once on a settled
// frame — the box keeps its room for good, empty if it must, because taking it away would pull
// the page up under the player's eyes.
//
// A tap on a tab's rows, or on the chip of the tab shown (the keyboard's way), opens that
// board: a group's (it becomes the group last opened) or the global one; a tap on another name
// turns to it. No analytics event. A sideways SWIPE on the rows turns the tab like a tap on a
// name (the rows are most of the box, and where a thumb swipes); it opens nothing.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { BAYER_8, type LiveGroup, type LiveBoard } from '@whippin/shared';
import { BoardRowItem, PlayingRowItem } from './BoardRows';
import { shownFace, useOwnFace } from './AccountFace';
import PlusIcon from '../assets/icons/plus.svg?react';
import { resultTabs, type ResultTab } from '../game/resultBoards';
import useGlobalBoard from '../hooks/useGlobalBoard';
import { prefersReducedMotion } from '../hooks/useScramble';
import { useDeviceIdentity } from '../identity';
import { t } from '../i18n';
import { pathForBoard } from '../langs';
import { navigate } from '../routing';
import { useGameStore } from '../state/gameStore';
import { askGroupCreate } from '../state/groups';

// A mark at an INTEGER cell scale: 10 cells of 3px.
const MARK = 30;
// A swipe on the rows: this far sideways, and mostly sideways (a scroll of the page is not one).
const SWIPE_PX = 40;
// One rank column for every tab, as wide as the widest rank any of them prints in the ranks'
// 16px digits (two at the least; the `+N` under the rows is set at half that size).
const RANK_DIGIT_PX = 16;
// The row of names' dithered edge: a tile of 2px cells, FADE_CELLS across and the Bayer
// matrix's 8 down, solid at its inner side and thinning to nothing at the outer — a CSS mask.
const FADE_CELLS = 16;
function fadeTile(towardRight: boolean): string {
  let rects = '';
  for (let r = 0; r < 8; r += 1) {
    for (let c = 0; c < FADE_CELLS; c += 1) {
      const k = (c + 0.5) / FADE_CELLS;
      const density = towardRight ? 1 - k : k;
      if (BAYER_8[r * 8 + (c & 7)] < density * 64) rects += `<rect x='${c * 2}' y='${r * 2}' width='2' height='2'/>`;
    }
  }
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${FADE_CELLS * 2}' height='16' shape-rendering='crispEdges'>${rects}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
const FADES = { '--fade-r': fadeTile(true), '--fade-l': fadeTile(false) } as CSSProperties;

export interface ResultBoardsData {
  // The active day, as the boards address it.
  date: string;
  // The live answer, or null: none yet, or none to show (no group holding somebody else).
  live: LiveBoard | null;
  // A live answer is on its way: the box holds its room for it rather than draw GLOBAL first
  // and turn to a group a moment later.
  awaited: boolean;
}

// The widest rank a tab prints, in the ranks' digits.
function rankDigits(tab: ResultTab): number {
  return Math.max(
    Math.ceil(String(`+${tab.board.more}`).length / 2),
    ...tab.board.lines.map((line) => (line.kind === 'ranked' ? String(line.row.rank).length : 1)),
  );
}

export default function ResultBoards({
  className,
  lang,
  date,
  live,
  awaited,
  tries,
  progress,
  ended,
  pageIn,
}: ResultBoardsData & {
  // The stage's own dress for the block (its beat), on the box itself: a block that draws
  // nothing leaves nothing in the stage's flow.
  className: string;
  lang: string;
  // The player's own result: their row is drawn from it, never from a guess.
  tries: number;
  progress: number;
  ended: boolean;
  // The sentence's page under the box has landed: from then on the box keeps its room.
  pageIn: boolean;
}) {
  const identity = useDeviceIdentity();
  const own = shownFace(useOwnFace());
  const lastGroupId = useGameStore((s) => s.lastGroupId);
  const setLastGroup = useGameStore((s) => s.setLastGroup);
  const setBoardTab = useGameStore((s) => s.setBoardTab);
  const globalBoard = useGlobalBoard(lang, date);
  // The tab the player turned to, by key: a tab arriving later never moves them off it. Once
  // they have turned, the chip is drawn across the name it moves to and the rows come in again.
  const [chosen, setChosen] = useState<string | null>(null);
  const [moved, setMoved] = useState(false);
  // A swipe on the rows in progress, and whether the last gesture was one (its click, a
  // mouse's, opens nothing).
  const swipe = useRef<{ id: number; x: number; y: number } | null>(null);
  const swiped = useRef(false);
  // The row of names: which of its edges run past the column (each then thins out).
  const tabsRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  // The box waits for EVERY read it draws from — the live answer and the GLOBAL one — before
  // it draws a tab (see the header).
  const pending = identity !== null && (awaited || globalBoard === null);
  const tabs: ResultTab[] =
    identity === null || pending
      ? []
      : resultTabs(live, globalBoard === 'failed' ? null : globalBoard, lastGroupId, {
          publicId: identity.accountId,
          name: own?.name ?? '',
          avatar: own?.avatar ?? null,
          tries,
          progress,
          ended,
        });
  const empty = tabs.length === 0 && !pending;
  const index = Math.max(0, tabs.findIndex((tab) => tab.key === chosen));
  const shown = tabs[index] as ResultTab | undefined;

  const onTabsScroll = useCallback(() => {
    const row = tabsRef.current;
    if (!row) return;
    const left = row.scrollLeft > 1;
    const right = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);
  const tabCount = tabs.length;
  useEffect(() => {
    const row = tabsRef.current;
    if (!row) return undefined;
    onTabsScroll();
    const ro = new ResizeObserver(onTabsScroll);
    ro.observe(row);
    return () => ro.disconnect();
  }, [onTabsScroll, tabCount]);
  // The name shown stays WHOLE in view: the row scrolls (on its own axis only) to the nearest
  // name's start that shows it entire, clear of the dithered edge.
  useEffect(() => {
    const row = tabsRef.current;
    const tab = row?.children[index] as HTMLElement | undefined;
    if (!row || !tab) return;
    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    const room = row.clientWidth - (right < row.scrollWidth - 1 ? FADE_CELLS * 2 : 0);
    let target: number | null = null;
    if (left < row.scrollLeft) target = left;
    else if (right > row.scrollLeft + room) {
      const starts = Array.from(row.children as HTMLCollectionOf<HTMLElement>, (el) => el.offsetLeft);
      target = starts.find((start) => start >= right - room) ?? left;
    }
    if (target !== null) row.scrollTo({ left: target, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [index, tabCount]);

  // The box's fate, latched (see the header): gone, kept, or still open.
  const [fate, setFate] = useState<'gone' | 'kept' | null>(null);
  const decided = fate ?? (pageIn ? 'kept' : empty ? 'gone' : null);
  if (decided !== fate) setFate(decided);
  if (decided === 'gone') return null;

  const turn = (i: number) => {
    const tab = tabs[i];
    if (!tab) return;
    setChosen(tab.key);
    setMoved(true);
  };
  const open = (group: LiveGroup | null) => {
    if (group) {
      setLastGroup(group.id);
      setBoardTab('group');
    } else {
      setBoardTab('global');
    }
    navigate(pathForBoard(lang));
  };
  const newGroup = () => {
    askGroupCreate();
    setBoardTab('group');
    navigate(pathForBoard(lang));
  };
  const rankWidth = Math.max(2, ...tabs.map(rankDigits)) * RANK_DIGIT_PX;

  return (
    <section
      className={`result-boards ${className}${moved ? ' moved' : ''}`}
      aria-label={t(lang, 'ariaLeaderboard')}
      style={{ '--rank-w': `${rankWidth}px` } as CSSProperties}
    >
      {shown && (
        <>
          <div className="result-boards-head">
            <div
              ref={tabsRef}
              className={`result-boards-tabs${edges.left ? ' fade-l' : ''}${edges.right ? ' fade-r' : ''}`}
              style={FADES}
              onScroll={onTabsScroll}
            >
              {tabs.map((tab, i) => (
                <button
                  key={tab.key}
                  type="button"
                  className={`result-boards-tab${i === index ? ' on' : ''}`}
                  aria-current={i === index || undefined}
                  onClick={() => (i === index ? open(tab.group) : turn(i))}
                >
                  <span className="result-boards-chip">{tab.group ? tab.group.name : t(lang, 'boardGlobal')}</span>
                </button>
              ))}
            </div>
            <button type="button" className="result-boards-add" aria-label={t(lang, 'groupNew')} onClick={newGroup}>
              <span className="result-boards-add-chip">
                <PlusIcon className="ui-icon" aria-hidden />
              </span>
            </button>
          </div>
          {/* The rows are a picture of the board, and the whole of it is the tap onto it; the
              keyboard's way there is the shown tab's name above. */}
          <div
            className="result-board"
            onPointerDown={(e) => {
              swipe.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
              swiped.current = false;
            }}
            onPointerUp={(e) => {
              const start = swipe.current;
              swipe.current = null;
              if (start === null || start.id !== e.pointerId) return;
              const dx = e.clientX - start.x;
              if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < 2 * Math.abs(e.clientY - start.y)) return;
              swiped.current = true;
              turn(index + (dx < 0 ? 1 : -1));
            }}
            onPointerCancel={() => {
              swipe.current = null;
            }}
            onClick={() => {
              if (swiped.current) swiped.current = false;
              else open(shown.group);
            }}
          >
            <ol key={shown.key} className="board-list">
              {shown.board.lines.map((line, i) =>
                line.kind === 'gap' ? (
                  <li key={`gap-${i}`} className="board-gap" style={{ '--i': i } as CSSProperties} aria-hidden="true" />
                ) : line.kind === 'ranked' ? (
                  <BoardRowItem key={line.row.publicId} row={line.row} me={line.me} index={i} mark={MARK} sharp />
                ) : (
                  <PlayingRowItem key={line.row.publicId} row={line.row} me={line.me} index={i} mark={MARK} sharp />
                ),
              )}
            </ol>
            {shown.board.more > 0 && (
              <div
                key={`more-${shown.key}`}
                className="result-board-more"
                style={{ '--i': shown.board.lines.length } as CSSProperties}
              >
                <span className="result-board-more-count">+{shown.board.more}</span>
                <span className="result-board-more-rail" aria-hidden="true" />
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
