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
// THE TABS are the groups' NAMES in a row, then GLOBAL — the boards' one control across the app
// (`BoardTabs`, the board screen's own): the one shown wearing the white title chip, which
// TRAVELS to the name turned to; GLOBAL pinned at the row's end, and where the names run past
// the column only whole ones show, the cut ones under the boards' left-out rail.
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
import { useId, useState } from 'react';
import type { CSSProperties } from 'react';
import type { LiveGroup, LiveBoard } from '@whippin/shared';
import BoardTabs, { tabIds } from './BoardTabs';
import { BoardRowItem, PlayingRowItem } from './BoardRows';
import { rankColumnPx } from './boardMetrics';
import { shownFace, useOwnFace } from './AccountFace';
import { resultTabs, type ResultTab } from '../game/resultBoards';
import useGlobalBoard from '../hooks/useGlobalBoard';
import useSwipe from '../hooks/useSwipe';
import { useDeviceIdentity } from '../identity';
import { t } from '../i18n';
import { pathForBoard } from '../langs';
import { navigate } from '../routing';
import { startOpening } from '../state/boardOpening';
import { useGameStore } from '../state/gameStore';

export interface ResultBoardsData {
  // The active day, as the boards address it.
  date: string;
  // The live answer, or null: none yet, or none to show (no group holding somebody else).
  live: LiveBoard | null;
  // A live answer is on its way: the box holds its room for it rather than draw GLOBAL first
  // and turn to a group a moment later.
  awaited: boolean;
}

// The widest rank a tab prints, in the ranks' digits (the `+N` under the rows is set at half
// their size) — one rank column for every tab (`rankColumnPx`).
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
  // they have turned, the chip travels to the name it moves to and the rows come in again.
  const [chosen, setChosen] = useState<string | null>(null);
  const [moved, setMoved] = useState(false);

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

  const turn = (i: number) => {
    const tab = tabs[i];
    if (!tab) return;
    setChosen(tab.key);
    setMoved(true);
  };
  const { handlers: swipe, swiped } = useSwipe((step) => turn(index + step));
  const tabsId = useId();

  // The box's fate, latched (see the header): gone, kept, or still open.
  const [fate, setFate] = useState<'gone' | 'kept' | null>(null);
  const decided = fate ?? (pageIn ? 'kept' : empty ? 'gone' : null);
  if (decided !== fate) setFate(decided);
  if (decided === 'gone') return null;

  const open = (group: LiveGroup | null) => {
    if (group) {
      setLastGroup(group.id);
      setBoardTab('group');
    } else {
      setBoardTab('global');
    }
    // The board's read starts here, before the screen it opens is mounted (a swipe's press
    // opens nothing, so it waits for the tap).
    startOpening(lang);
    navigate(pathForBoard(lang));
  };
  const rankWidth = rankColumnPx(Math.max(0, ...tabs.map(rankDigits)));

  return (
    <section
      className={`result-boards ${className}${moved ? ' moved' : ''}`}
      aria-label={t(lang, 'ariaLeaderboard')}
      style={{ '--rank-w': `${rankWidth}px` } as CSSProperties}
    >
      {shown && (
        <>
          <BoardTabs
            tabs={tabs.map((tab) => ({
              key: tab.key,
              label: tab.group ? tab.group.name : t(lang, 'boardGlobal'),
              pinned: tab.group === null,
            }))}
            shown={index}
            onTurn={turn}
            onOpen={(i) => open(tabs[i]?.group ?? null)}
            idBase={tabsId}
          />
          {/* The rows are a picture of the board, and the whole of it is the tap onto it; the
              keyboard's way there is the shown tab's name above. */}
          <div
            className="result-board"
            role="tabpanel"
            id={tabIds(tabsId).panel}
            aria-labelledby={tabIds(tabsId).tab(shown.key)}
            {...swipe}
            onClick={(e) => !swiped(e) && open(shown.group)}
          >
            <ol key={shown.key} className="board-list">
              {shown.board.lines.map((line, i) =>
                line.kind === 'gap' ? (
                  <li key={`gap-${i}`} className="board-gap" style={{ '--i': i } as CSSProperties} aria-hidden="true" />
                ) : line.kind === 'ranked' ? (
                  <BoardRowItem key={line.row.publicId} row={line.row} value={line.row.score} me={line.me} index={i} />
                ) : (
                  <PlayingRowItem key={line.row.publicId} row={line.row} me={line.me} index={i} />
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
