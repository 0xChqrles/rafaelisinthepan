// THE RESULT'S BOARDS: under SHARE, how the player's day compares — each of their groups in
// turn, then GLOBAL, swiped through on the board's own pager (dots under it, no plus). Each
// tab is a few of the board's own rows (`BoardRows`), picked by `game/resultBoards.ts`: the
// whole day when it fits, else the podium, the player's ±1 and a few still playing, the box
// filled with the rows next in line, and a `+N`.
//
// The data is not this screen's to fetch twice: the groups come off the LIVE read the play
// screen already keeps (`state/liveBoard.ts`), passed in; GLOBAL is one anonymous read of the
// global board per mount (`useGlobalBoard`). The active day only — the caller mounts this for
// nothing else.
//
// ONE FIXED BOX, whatever it holds: empty while the first answers are out, the same height on
// every tab, so nothing that has landed moves when a read arrives or a swipe turns the page.
// Its fate is decided ONCE, by the page under it: a box whose reads have all answered with
// nothing to show BEFORE the page lands leaves the stage's flow (the page has not shown, so
// nothing seen moves) and never comes back; once the page has landed — at once on a settled
// frame — the box keeps its room for good, empty if it must, because taking it away would pull
// the page up under the player's eyes.
//
// A tap on a tab's rows, or on its name in the middle, opens that board: a group's (it becomes
// the group last opened) or the global one. No analytics event. A sideways SWIPE on the rows
// turns the tab like one on the names above (the rows are most of the box, and where a thumb
// swipes); it opens nothing.
import { useRef, useState } from 'react';
import type { LiveBoard } from '@whippin/shared';
import { BoardRowItem, PlayingRowItem } from './BoardRows';
import ScopePager from './ScopePager';
import { shownFace, useOwnFace } from './AccountFace';
import { resultTabs, type ResultTab } from '../game/resultBoards';
import useGlobalBoard from '../hooks/useGlobalBoard';
import { useDeviceIdentity } from '../identity';
import { t } from '../i18n';
import { pathForBoard, type LangCode } from '../langs';
import { navigate } from '../routing';
import { useGameStore } from '../state/gameStore';

// A mark at an INTEGER cell scale: 10 cells of 2px, the race line's own size.
const MARK = 20;
// A swipe on the rows: this far sideways, and mostly sideways (a scroll of the page is not one).
const SWIPE_PX = 40;

export interface ResultBoardsData {
  // The active day, as the boards address it.
  date: string;
  // The live answer, or null: none yet, or none to show (no group holding somebody else).
  live: LiveBoard | null;
  // A live answer is on its way: the box holds its room for it rather than draw GLOBAL first
  // and turn to a group a moment later.
  awaited: boolean;
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
  // The tab the player turned to, by key: a tab arriving later never moves them off it.
  const [chosen, setChosen] = useState<string | null>(null);
  // A swipe on the rows in progress, and whether the last gesture was one (its click, a
  // mouse's, opens nothing).
  const swipe = useRef<{ id: number; x: number; y: number } | null>(null);
  const swiped = useRef(false);

  const tabs: ResultTab[] =
    identity === null || awaited
      ? []
      : resultTabs(live, globalBoard === 'failed' ? null : globalBoard, lastGroupId, {
          publicId: identity.accountId,
          name: own?.name ?? '',
          avatar: own?.avatar ?? null,
          tries,
          progress,
          ended,
        });
  const pending = identity !== null && (awaited || (tabs.length === 0 && globalBoard === null));
  const empty = tabs.length === 0 && !pending;
  // The box's fate, latched (see the header): gone, kept, or still open.
  const [fate, setFate] = useState<'gone' | 'kept' | null>(null);
  const decided = fate ?? (pageIn ? 'kept' : empty ? 'gone' : null);
  if (decided !== fate) setFate(decided);
  if (decided === 'gone') return null;

  const index = Math.max(0, tabs.findIndex((tab) => tab.key === chosen));
  const shown = tabs[index] as ResultTab | undefined;
  const open = (tab: ResultTab) => {
    if (tab.group) {
      setLastGroup(tab.group.id);
      setBoardTab('group');
    } else {
      setBoardTab('global');
    }
    navigate(pathForBoard(lang));
  };

  return (
    <section
      className={`result-boards ${className}${tabs.length === 1 ? ' single' : ''}`}
      aria-label={t(lang, 'ariaLeaderboard')}
    >
      {shown && (
        <>
          <ScopePager
            lang={lang as LangCode}
            scopes={tabs.map((tab) => ({ key: tab.key, title: tab.group ? tab.group.name : t(lang, 'boardGlobal') }))}
            active={index}
            onChange={(i) => setChosen(tabs[i]?.key ?? null)}
            onOpen={(i) => {
              const tab = tabs[i];
              if (tab) open(tab);
            }}
          />
          {/* The rows are a picture of the board, and the whole of it is the tap onto it; the
              keyboard's way there is the tab's name above. */}
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
              const next = tabs[index + (dx < 0 ? 1 : -1)];
              if (next) setChosen(next.key);
            }}
            onPointerCancel={() => {
              swipe.current = null;
            }}
            onClick={() => {
              if (swiped.current) swiped.current = false;
              else open(shown);
            }}
          >
            <ol key={shown.key} className="board-list">
              {shown.board.lines.map((line, i) =>
                line.kind === 'gap' ? (
                  <li key={`gap-${i}`} className="board-gap" aria-hidden="true" />
                ) : line.kind === 'ranked' ? (
                  <BoardRowItem key={line.row.publicId} row={line.row} me={line.me} index={i} mark={MARK} />
                ) : (
                  <PlayingRowItem key={line.row.publicId} row={line.row} me={line.me} index={i} mark={MARK} />
                ),
              )}
            </ol>
            {shown.board.more > 0 && <span className="result-board-more">+{shown.board.more}</span>}
          </div>
        </>
      )}
    </section>
  );
}
