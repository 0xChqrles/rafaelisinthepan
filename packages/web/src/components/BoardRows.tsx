// A board's ROWS — one player each — drawn by every surface that lists players on a day: the
// leaderboard screen and the solved screen's boards. One component per row kind, so the two
// surfaces cannot say one player two ways, and ONE DRESS (user-decided 2026-10-02 for the
// result's boards; the board screen took it with its own redesign): LINES OF TYPE on the bare
// ground — the rank in the pixel face or the crown, the mark SQUARE at 3px a cell (30px, among
// pixel type), the name, the number in the pixel face at the far edge. What differs is only the
// MOTION, which each surface passes in: the board screen's numbers land on the count's reels
// (`run`); the result's lines do not, the count above them being that screen's subject (as the
// board screen's is its podium, whose leader's count is the foil).
import type { CSSProperties } from 'react';
import { anonName, defaultAvatar, progressHeatColor, type BoardPlayer, type PlayingRow } from '@whippin/shared';
import Avatar from './Avatar';
import { MARK } from './boardMetrics';
import InfinityGlyph from './InfinityGlyph';
import ReelNumber from './ReelNumber';
import CrownIcon from '../assets/icons/board.svg?react';
import { shownPercent } from '../game/race';
import { t } from '../i18n';

// A line's arrival on the board screen: when it comes in (its mask dissolving through the
// Bayer levels, CSS `--delay`) and how long its number's reels then run; the number LANDS at
// the sum (`--land`), and anything that waits for it (a playing member's %) keys off that.
export interface LineRun {
  delayMs: number;
  runMs: number;
}

const runStyle = (run: LineRun | undefined, i: number): CSSProperties =>
  ({
    '--i': i,
    ...(run ? { '--delay': `${run.delayMs}ms`, '--land': `${run.delayMs + run.runMs}ms` } : {}),
  }) as CSSProperties;

// The number: on the count's reels when the surface runs them, else simply printed (in the
// face's fixed advance, the reels' own box: nothing moves either way).
function Count({ value, run }: { value: number; run?: LineRun }) {
  return run && run.runMs > 0 ? <ReelNumber value={value} delayMs={run.delayMs} runMs={run.runMs} /> : <>{value}</>;
}

// A row's rank: the number in the quiet pixel face, printed bare (a rank is written bare) —
// and FIRST PLACE WEARS THE CROWN instead, the header's own board mark in the accent (the
// palette's "every solved word/trophy/terminus" blue). Competition ranks share a first, so a
// tie crowns every row that holds it. The number stays for a screen reader.
export function BoardRank({ rank }: { rank: number }) {
  if (rank !== 1) return <span className="board-rank">{rank}</span>;
  return (
    <span className="board-rank crown">
      <CrownIcon className="ui-icon" aria-hidden />
      <span className="sr-only">#1</span>
    </span>
  );
}

const Name = ({ player }: { player: BoardPlayer }) => (
  <span className={`board-name${player.name ? '' : ' anon'}`}>{player.name || anonName(player.publicId)}</span>
);

// A ranked row: its number is the day's tries, or a WEEK's or a MONTH's points.
export function BoardRowItem({
  row,
  value,
  me,
  mate = false,
  index,
  run,
}: {
  row: BoardPlayer & { rank: number };
  value: number;
  me: boolean;
  mate?: boolean;
  index: number;
  run?: LineRun;
}) {
  return (
    <li
      // `me` wins over `mate`: your own row is never one of your people, but a stale list
      // could say so, and two markers on one row is a rendering bug on screen.
      className={`board-row${me ? ' me' : mate ? ' mate' : ''}`}
      style={runStyle(run, index)}
      aria-current={me || undefined}
    >
      <BoardRank rank={row.rank} />
      <Avatar avatar={row.avatar ?? defaultAvatar(row.publicId)} size={MARK} sharp />
      <Name player={row} />
      <span className="board-score">
        <Count value={value} run={run} />
      </span>
    </li>
  );
}

// A member mid-round — or done with nothing recorded: a round that ENDED UNSOLVED (`over`:
// given up, or capped) prints `∞` where the tries would be, its % kept quiet, after the live
// rows (the shared `orderPlaying`), and says `srUnsolved` to a screen reader — the word the
// race line and the calendar say. No rank: a position mid-round is never a rank claim (#206).
export function PlayingRowItem({
  row,
  me,
  lang,
  index,
  run,
}: {
  row: PlayingRow;
  me: boolean;
  lang: string;
  index: number;
  run?: LineRun;
}) {
  return (
    <li
      className={`board-row playing${row.over ? ' over' : ''}${me ? ' me' : ''}`}
      style={{ ...runStyle(run, index), '--play-heat': progressHeatColor(row.progress) } as CSSProperties}
      aria-current={me || undefined}
    >
      <span className="board-norank" aria-hidden="true" />
      <Avatar avatar={row.avatar ?? defaultAvatar(row.publicId)} size={MARK} sharp />
      <Name player={row} />
      <span className="board-progress">{shownPercent(row.progress)}%</span>
      <span className="board-score">
        {row.over ? (
          <>
            <InfinityGlyph className="board-inf" cell={2} />
            <span className="sr-only">{t(lang, 'srUnsolved')}</span>
          </>
        ) : (
          <Count value={row.tries} run={run} />
        )}
      </span>
    </li>
  );
}

// A member with no score today: the person, muted, and no rank and nothing where a number
// would be — which says they have not played yet, with no caption to say it.
export function WaitingRowItem({ player, index, run }: { player: BoardPlayer; index: number; run?: LineRun }) {
  return (
    <li className="board-row waiting" style={runStyle(run, index)}>
      <span className="board-norank" aria-hidden="true" />
      <Avatar avatar={player.avatar ?? defaultAvatar(player.publicId)} size={MARK} sharp />
      <Name player={player} />
    </li>
  );
}

// WHILE A BOARD'S FIRST READ IS OUT: a line's boxes as stippled slate — a checker where the mark
// will stand, a rail where the name will — at the lines' own pitch, so nothing moves when the
// board lands (the board screen's skeleton and the result's). The rails' lengths, line by line;
// and one line: its rail's length (`--w`) and when it comes in through the dither (`--delay`).
export const SKELETON_WIDTHS = [62, 48, 70, 54, 40] as const;
export function SkeletonLine({ width, delayMs }: { width: number; delayMs: number }) {
  return (
    <span
      className="board-skeleton-line"
      style={{ '--w': `${width}%`, '--delay': `${delayMs}ms` } as CSSProperties}
      aria-hidden="true"
    >
      <span className="board-skeleton-mark" />
      <span className="board-skeleton-name" />
    </span>
  );
}
