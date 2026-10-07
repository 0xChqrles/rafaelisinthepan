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
// the column only whole ones show, the cut ones under the boards' left-out rail. A player none
// of whose groups holds anybody else has the SEAT before GLOBAL instead, and the box opens on it
// (`SeatPanel`): the board screen's bare `NO GROUP`, or their group of one by name, holding
// their own line over the call that creates or invites in place.
//
// The data is not this screen's to fetch twice: the groups come off the LIVE read the play
// screen already keeps (`state/liveBoard.ts`), passed in, and the seat off the groups list it
// already holds; GLOBAL is one anonymous read of the global board per mount (`useGlobalBoard`).
// The active day only — the caller mounts this for nothing else.
//
// ONE FIXED BOX, whatever it holds: the same height on every tab, so nothing that has landed
// moves when a read arrives or a swipe turns the page. It draws no tab until the GLOBAL read has
// answered too (a failure is an answer): the tabs and the rank column they share are decided
// together, and a global rank of three digits landing late would widen that column under a
// group's lines already shown.
// WHILE THE FIRST ANSWERS ARE OUT the box HOLDS what is coming, the board screen's own way: one
// stippled chip where the tab's chip will stand (`BoardTabs`' hold) and the skeleton's lines at
// the lines' pitch (`SkeletonLine`) — in only once the box is on screen and the reads have been
// out SKELETON_WAIT_MS more, so a quick answer never flashes them. Lines landing in a box already
// on screen DISSOLVE in, the skeleton's lines that had come in going out through the cells they
// take, one for one; lines that land before the box shows arrive on its own beat.
// Its fate is decided ONCE, by the page under it: a box whose reads have all answered with
// nothing to show BEFORE the page lands leaves the stage's flow (the page has not shown, so
// nothing seen moves) and never comes back; once the page has landed — at once on a settled
// frame — the box keeps its room for good, empty if it must, because taking it away would pull
// the page up under the player's eyes.
//
// A tap on a tab's rows, or on the chip of the tab shown (the keyboard's way), opens that
// board: a group's (it becomes the group last opened), the global one, or — from the seat —
// the board's group tab, on the group of one if there is one; a tap on another name turns to
// it. Only the seat's call acts in place. No analytics event. A sideways SWIPE on the rows
// turns the tab like a tap on a name (the rows are most of the box, and where a thumb swipes);
// it opens nothing.
import { useId, useState } from 'react';
import type { CSSProperties, HTMLAttributes } from 'react';
import type { GroupSummary, LiveBoard } from '@whippin/shared';
import { clockNow } from './animationClock';
import { SKELETON_STAGGER_MS, SKELETON_WAIT_MS, cameIn } from './bayerTiles';
import BoardTabs, { tabIds } from './BoardTabs';
import { BoardRowItem, PlayingRowItem, SKELETON_WIDTHS, SkeletonLine } from './BoardRows';
import { rankColumnPx } from './boardMetrics';
import { shownFace, useOwnFace } from './AccountFace';
import SeatPanel from './SeatPanel';
import { resultTabs, seatOf, type ResultTab } from '../game/resultBoards';
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
  // The groups list as held — null while unknown: the seat's one source.
  groups: readonly GroupSummary[] | null;
}

// The widest rank a tab prints, in the ranks' digits (the `+N` under the rows is set at half
// their size) — one rank column for every tab (`rankColumnPx`). The seat prints none.
function rankDigits(tab: ResultTab): number {
  if (tab.kind === 'seat') return 0;
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
  groups,
  tries,
  progress,
  ended,
  pageIn,
  arrived,
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
  // The box is on screen (its beat has come): the hold's wait counts from here.
  arrived: boolean;
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

  // THE SEAT IS DECIDED ONCE THE BOX HAS DRAWN: the list it was decided off is held where a
  // later one would take the seat away or bring one in (a friend's join read back), so a tab
  // that has landed never leaves the row; a list that keeps it (the group just created) is
  // read as it comes.
  const [seatFrom, setSeatFrom] = useState<readonly GroupSummary[] | null | undefined>(undefined);
  const seated = (list: readonly GroupSummary[] | null) => seatOf(list, lastGroupId) !== null;
  const seatGroups = seatFrom === undefined || seated(seatFrom) === seated(groups) ? groups : seatFrom;

  // The box waits for EVERY read it draws from — the live answer and the GLOBAL one — before
  // it draws a tab (see the header).
  const pending = identity !== null && (awaited || globalBoard === null);
  const tabs: ResultTab[] =
    identity === null || pending
      ? []
      : resultTabs(
          live,
          globalBoard === 'failed' ? null : globalBoard,
          lastGroupId,
          {
            publicId: identity.accountId,
            name: own?.name ?? '',
            avatar: own?.avatar ?? null,
            tries,
            progress,
            ended,
          },
          seatGroups,
        );
  const empty = tabs.length === 0 && !pending;

  // THE HOLD (see the header), for the FIRST answers only: when it went on screen, and — latched
  // as they land — whether the lines land over it, and how many of its lines had come in by then.
  const [holdFrom, setHoldFrom] = useState<number | null>(null);
  const [landed, setLanded] = useState<{ over: boolean; came: number } | null>(null);
  const holding = pending && landed === null;
  if (holding && arrived && holdFrom === null) setHoldFrom(clockNow());
  if (!pending && identity !== null && landed === null) {
    const shownFor = holdFrom === null ? null : clockNow() - holdFrom;
    setLanded({
      over: shownFor !== null,
      came:
        shownFor === null
          ? 0
          : SKELETON_WIDTHS.filter((_, i) => cameIn(SKELETON_WAIT_MS + i * SKELETON_STAGGER_MS, shownFor)).length,
    });
  }
  const index = Math.max(0, tabs.findIndex((tab) => tab.key === chosen));
  const shown = tabs[index] as ResultTab | undefined;
  if (shown !== undefined && seatFrom !== seatGroups) setSeatFrom(seatGroups);

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

  const open = (tab: ResultTab) => {
    if (tab.kind === 'global') {
      setBoardTab('global');
    } else {
      // The seat's is the board's group tab: its NO GROUP, or the group of one.
      if (tab.group) setLastGroup(tab.group.id);
      setBoardTab('group');
    }
    // The board's read starts here, before the screen it opens is mounted (a swipe's press
    // opens nothing, so it waits for the tap).
    startOpening(lang);
    navigate(pathForBoard(lang));
  };
  const rankWidth = rankColumnPx(Math.max(0, ...tabs.map(rankDigits)));
  // Every tab's panel: the row's tabpanel, labelled by the tab shown, the swipe, and the tap
  // onto the board — the seat's included (its call alone acts in place).
  const panel = (tab: ResultTab): HTMLAttributes<HTMLDivElement> => ({
    role: 'tabpanel',
    id: tabIds(tabsId).panel,
    'aria-labelledby': tabIds(tabsId).tab(tab.key),
    ...swipe,
    onClick: (e) => {
      if (!swiped(e)) open(tab);
    },
  });

  return (
    <section
      className={`result-boards ${className}${moved ? ' moved' : ''}${landed?.over ? ' over-hold' : ''}`}
      aria-label={t(lang, 'ariaLeaderboard')}
      aria-busy={holding || undefined}
      style={{ '--rank-w': `${rankWidth}px`, '--stagger': `${SKELETON_STAGGER_MS}ms` } as CSSProperties}
    >
      {holding && <BoardTabs tabs={[]} shown={0} onTurn={() => {}} idBase={tabsId} />}
      {/* The skeleton: in while the first answers are out; then, where the lines land over it,
          what of it had come in, going out under them. */}
      {(holding || (landed !== null && landed.came > 0)) && (
        <div className={`result-boards-hold${holding ? '' : ' leaving'}`} role={holding ? 'status' : undefined}>
          {holding && <span className="sr-only">{t(lang, 'loading')}</span>}
          {SKELETON_WIDTHS.slice(0, holding ? undefined : landed?.came).map((width, i) => (
            <SkeletonLine
              key={i}
              width={width}
              delayMs={holding ? SKELETON_WAIT_MS + i * SKELETON_STAGGER_MS : i * SKELETON_STAGGER_MS}
            />
          ))}
        </div>
      )}
      {shown && (
        <>
          <BoardTabs
            tabs={tabs.map((tab) =>
              tab.kind === 'global'
                ? { key: tab.key, label: t(lang, 'boardGlobal'), pinned: true }
                : tab.group
                  ? { key: tab.key, label: tab.group.name }
                  : // The seat with no group: the board screen's own word, a state and not a
                    // name (no chip).
                    { key: tab.key, label: t(lang, 'boardEmptyGroups'), bare: true },
            )}
            shown={index}
            onTurn={turn}
            onOpen={(i) => tabs[i] && open(tabs[i])}
            idBase={tabsId}
          />
          {/* The rows are a picture of the board, and the whole of it is the tap onto it; the
              keyboard's way there is the shown tab's name above. */}
          {shown.kind === 'seat' ? (
            <SeatPanel lang={lang} group={shown.group} own={shown.own} panel={panel(shown)} swiped={swiped} />
          ) : (
            <div className="result-board" {...panel(shown)}>
              <ol key={shown.key} className="board-list">
                {shown.board.lines.map((line, i) =>
                  line.kind === 'gap' ? (
                    <li key={`gap-${i}`} className="board-gap" style={{ '--i': i } as CSSProperties} aria-hidden="true" />
                  ) : line.kind === 'ranked' ? (
                    <BoardRowItem key={line.row.publicId} row={line.row} value={line.row.score} me={line.me} index={i} />
                  ) : (
                    <PlayingRowItem key={line.row.publicId} row={line.row} me={line.me} lang={lang} index={i} />
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
          )}
        </>
      )}
    </section>
  );
}
