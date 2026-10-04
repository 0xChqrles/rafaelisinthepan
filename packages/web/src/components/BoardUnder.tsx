import { useState, type CSSProperties, type ReactNode } from 'react';
import { anonName } from '@whippin/shared';
import { DISSOLVE_MS, SKELETON_STAGGER_MS, SKELETON_WAIT_MS } from './bayerTiles';
import { rankColumnPx } from './boardMetrics';
import { BoardRowItem, PlayingRowItem, WaitingRowItem, type LineRun } from './BoardRows';
import type { PodiumEntry } from './podium/Podium';
import ChevronIcon from '../assets/icons/chevron-left.svg?react';
import { boardSlots, rankDigits } from '../game/boardSlots';
import type { AnyBoard, ShownBoard } from '../game/boardView';
import { t } from '../i18n';
import type { LangCode } from '../langs';

// WHAT STANDS UNDER THE BOARD SCREEN'S PODIUM (`Leaderboard` keeps the state, the reads and
// the acts; this draws): a group's header slot — its door, and the unit when nothing above says
// it — then the board's lines, the loading skeleton, or (with no podium) the empty board's own
// block; and how each of them comes in, slot by slot, on the board's pace.

// THE PACE of a board: when it begins, how far apart its lines follow, and how long each
// number's reels run. The ARRIVAL leaves the head its beats first (the chip drawn across, the
// brackets locking on) and lands slower; a TURN comes straight in. The lines themselves start
// on the podium's own beat (`Beats.lines`).
export interface Pace {
  startMs: number;
  staggerMs: number;
  runMs: number;
}
export const ARRIVE: Pace = { startMs: 260, staggerMs: 55, runMs: 650 };
export const TURN: Pace = { startMs: 0, staggerMs: 30, runMs: 420 };
// Past the FOLD (the column's last whole slot on screen, and never past PACE_CAP) the lines
// come in together with the last one shown — and so does your line held at the column's edge,
// which covers exactly that slot: the two dissolve in through the same cells at the same
// instant, so the one under it never shows through.
export const PACE_CAP = 14;
// How a list's lines come in: the pace (from the podium's beat) and the fold.
export interface ListRun {
  pace: Pace;
  fold: number;
}
export const lineRun = ({ pace, fold }: ListRun, i: number): LineRun => ({
  delayMs: pace.startMs + Math.min(i, fold) * pace.staggerMs,
  runMs: pace.runMs,
});
const SKELETON_LINES = [62, 48, 70, 54, 40];

// The board on screen: which board, read for which tab (and which group), and the pace it came
// in at.
export interface Shown extends ShownBoard {
  group: string | null;
  pace: Pace;
}

// WHAT STANDS UNDER THE PODIUM, as one view: its identity (a new one gives way to the one
// before), the header slot (`sub`: a group's, holding its DOOR — the group's size — and the
// UNIT when nothing above says what the numbers count), and its body: the lines of the board
// shown, the skeleton, the empty board's own block (with no podium to hold it), or nothing.
// `shownFor`: how long it had been on screen when it began to give way.
export interface UnderView {
  key: string;
  sub: boolean;
  door: number | null;
  unit: 'tries' | 'points' | null;
  body: 'list' | 'skeleton' | 'hold' | null;
  shown: Shown | null;
  shownFor: number;
}

// A view under the podium, slot after slot: the header slot first (a group's), then the body.
// `out`: the view before, giving way — every slot dissolving OUT on the beat the slot that
// takes it dissolves in (the same `run`), its numbers standing, nothing in it reachable.
export default function Under({
  view,
  out = false,
  run,
  lang,
  meId,
  mates,
  places,
  onDoor,
  hold,
}: {
  view: UnderView;
  out?: boolean;
  run: ListRun;
  lang: LangCode;
  meId?: string;
  mates: ReadonlySet<string>;
  // The podium's places, said first in the list for a screen reader (null: no podium — the
  // lines start at the first).
  places: readonly (PodiumEntry | null)[] | null;
  onDoor: () => void;
  hold: ReactNode;
}) {
  const offset = view.sub ? 1 : 0;
  const { shown } = view;
  const list = { meId, run, offset, out, podium: places !== null, places: out ? null : places };
  return (
    <div className={out ? 'board-under-out' : 'board-under-in'} aria-hidden={out || undefined}>
      {view.sub && (
        <div className="board-sub" style={{ '--delay': `${lineRun(run, 0).delayMs}ms` } as CSSProperties}>
          {view.door !== null &&
            (out ? (
              <span className="board-door">
                <DoorLabel lang={lang} count={view.door} />
              </span>
            ) : (
              <button type="button" className="board-door" onClick={onDoor}>
                <DoorLabel lang={lang} count={view.door} />
              </button>
            ))}
          {view.unit && (
            <span className="board-unit" aria-hidden="true">
              {t(lang, view.unit)}
            </span>
          )}
        </div>
      )}
      {view.body === 'list' && shown ? (
        <BoardList
          board={shown.board}
          // Only the GLOBAL list marks the reader's people: on a group's board every row is
          // one, and marking everything marks nothing.
          mates={shown.tab === 'global' ? mates : null}
          {...list}
        />
      ) : view.body === 'skeleton' ? (
        <Skeleton lang={lang} run={run} offset={offset} out={out} shownFor={view.shownFor} />
      ) : view.body === 'hold' && !out ? (
        hold
      ) : null}
    </div>
  );
}

// The door's words: the group's size, the quiet word, the header's chevron turned to point in.
function DoorLabel({ lang, count }: { lang: LangCode; count: number }) {
  return (
    <>
      {count} {t(lang, count === 1 ? 'memberUnit' : 'membersUnit')}
      <ChevronIcon className="ui-icon" aria-hidden />
    </>
  );
}

// WHILE THE FIRST READ IS OUT: the board's lines as stippled rails where the marks and the
// names will stand — the box of what is coming, at its pitch, so nothing moves when it lands.
// They come in only if the read is slow (SKELETON_WAIT_MS, then SKELETON_STAGGER_MS apart).
// Giving way (`out`), only the lines that had come in by then are there to go.
function Skeleton({
  lang,
  run,
  offset,
  out,
  shownFor,
}: {
  lang: LangCode;
  run: ListRun;
  offset: number;
  out: boolean;
  shownFor: number;
}) {
  const lines = out
    ? SKELETON_LINES.filter((_, i) => shownFor >= SKELETON_WAIT_MS + i * SKELETON_STAGGER_MS + DISSOLVE_MS)
    : SKELETON_LINES;
  return (
    <div className="board-skeleton" role={out ? undefined : 'status'}>
      {!out && <span className="sr-only">{t(lang, 'loading')}</span>}
      {lines.map((width, i) => (
        <span
          key={i}
          className="board-skeleton-line"
          style={
            {
              '--w': `${width}%`,
              '--delay': `${out ? lineRun(run, offset + i).delayMs : SKELETON_WAIT_MS + i * SKELETON_STAGGER_MS}ms`,
            } as CSSProperties
          }
          aria-hidden="true"
        >
          <span className="board-skeleton-mark" />
          <span className="board-skeleton-name" />
        </span>
      ))}
    </div>
  );
}

// The podium's places, said for a screen reader as the board's first items (the podium itself
// is a picture): rank, name, value, unit.
function PodiumItems({ places }: { places: readonly (PodiumEntry | null)[] | null }) {
  if (!places) return null;
  return (
    <>
      {places.map((place) =>
        place ? (
          <li key={place.player.publicId} className="sr-only" aria-current={place.me || undefined}>
            #{place.rank} {place.player.name || anonName(place.player.publicId)} {place.value} {place.unit.toLowerCase()}
          </li>
        ) : null,
      )}
    </>
  );
}

interface ListProps {
  meId?: string;
  run: ListRun;
  // The slot the list's first line stands in (after the header's), and whether it is giving way.
  offset: number;
  out: boolean;
  // A podium stands over the list (its three are not lines), and its places, said first for a
  // screen reader (null: not said — giving way, or no podium).
  podium: boolean;
  places: readonly (PodiumEntry | null)[] | null;
}

// A list's run, latched as it came on screen (a re-read never re-times its lines) — giving way,
// its numbers stand.
function useListRun(props: ListProps): ListRun {
  const [run] = useState(props.run);
  return props.out ? { ...run, pace: { ...run.pace, runMs: 0 } } : run;
}

// A board's lines past the podium's three (or all of them, with no podium), slot by slot
// (`boardSlots`), each coming in on its slot's beat — ONE rank column for the whole list, as
// wide as its widest rank.
function BoardList(props: ListProps & { board: AnyBoard; mates: ReadonlySet<string> | null }) {
  const { board, meId, mates, offset, podium, places } = props;
  const run = useListRun(props);
  const slots = boardSlots(board, podium);
  return (
    <ol className="board-list" style={{ '--rank-w': `${rankColumnPx(rankDigits(slots))}px` } as CSSProperties}>
      <PodiumItems places={places} />
      {slots.map((slot, k) => {
        const i = offset + k;
        const at = lineRun(run, i);
        switch (slot.kind) {
          case 'ranked':
            return (
              <BoardRowItem
                key={`r:${slot.row.publicId}`}
                row={slot.row}
                value={slot.value}
                me={slot.row.publicId === meId}
                mate={mates?.has(slot.row.publicId) ?? false}
                index={i}
                run={at}
              />
            );
          case 'gap':
            return <li key="gap" className="board-gap" aria-hidden="true" style={{ '--delay': `${at.delayMs}ms` } as CSSProperties} />;
          case 'playing':
            return <PlayingRowItem key={`p:${slot.row.publicId}`} row={slot.row} me={slot.row.publicId === meId} index={i} run={at} />;
          case 'waiting':
            return <WaitingRowItem key={`w:${slot.player.publicId}`} player={slot.player} index={i} run={at} />;
        }
      })}
    </ol>
  );
}
