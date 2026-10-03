// A board's ROWS — one player each — drawn by every surface that lists players on a day: the
// leaderboard screen and the solved screen's boards. One component per row kind, so the two
// surfaces cannot say one player two ways, and ONE DRESS (user-decided 2026-10-02 for the
// result's boards; the board screen took it with its own redesign): LINES OF TYPE on the bare
// ground — the rank in the pixel face or the crown, the mark SQUARE at 3px a cell (30px, among
// pixel type), the name, the number in the pixel face at the far edge. What differs is only the
// MOTION, which each surface passes in: the board screen's numbers land on the count's reels
// (`run`) and its leader's crown in the foil (`shine`); the result's lines carry neither, the
// count above them being that screen's shiny subject.
import type { CSSProperties } from 'react';
import {
  anonName,
  defaultAvatar,
  progressHeatColor,
  type BoardPlayer,
  type BoardRow,
  type PlayingRow,
} from '@whippin/shared';
import Avatar from './Avatar';
import FoilCrown from './FoilCrown';
import InfinityGlyph from './InfinityGlyph';
import ReelNumber from './ReelNumber';
import CrownIcon from '../assets/icons/board.svg?react';
import { shownPercent } from '../game/race';

// A mark at an INTEGER cell scale: 10 cells of 3px.
export const MARK = 30;

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

// The number: on the count's reels when the surface runs them, else simply printed.
function Count({ value, run }: { value: number; run?: LineRun }) {
  return run ? <ReelNumber value={value} delayMs={run.delayMs} runMs={run.runMs} /> : <>{value}</>;
}

// A row's rank: the number in the quiet pixel face, printed bare (a rank is written bare) —
// and FIRST PLACE WEARS THE CROWN instead, the header's own board mark in the accent (the
// palette's "every solved word/trophy/terminus" blue), or, on the board screen, in the FOIL
// (`shine`: it lights when the leader's number lands). Competition ranks share a first, so a
// tie crowns every row that holds it. The number stays for a screen reader.
export function BoardRank({ rank, shine }: { rank: number; shine?: { litMs: number; seed: number } }) {
  if (rank !== 1) return <span className="board-rank">{rank}</span>;
  return (
    <span className="board-rank crown">
      {shine ? <FoilCrown litMs={shine.litMs} seed={shine.seed} /> : <CrownIcon className="ui-icon" aria-hidden />}
      <span className="sr-only">#1</span>
    </span>
  );
}

const Name = ({ player }: { player: BoardPlayer }) => (
  <span className={`board-name${player.name ? '' : ' anon'}`}>{player.name || anonName(player.publicId)}</span>
);

export function BoardRowItem({
  row,
  me,
  mate = false,
  index,
  run,
  shine = false,
}: {
  row: BoardRow;
  me: boolean;
  mate?: boolean;
  index: number;
  run?: LineRun;
  // The crown in the foil (first place, on the board screen).
  shine?: boolean;
}) {
  return (
    <li
      // `me` wins over `mate`: your own row is never one of your people, but a stale list
      // could say so, and two markers on one row is a rendering bug on screen.
      className={`board-row${me ? ' me' : mate ? ' mate' : ''}`}
      style={runStyle(run, index)}
      aria-current={me || undefined}
    >
      <BoardRank rank={row.rank} shine={shine ? { litMs: run ? run.delayMs + run.runMs : 0, seed: index + 3 } : undefined} />
      <Avatar avatar={row.avatar ?? defaultAvatar(row.publicId)} size={MARK} sharp />
      <Name player={row} />
      <span className="board-score">
        <Count value={row.score} run={run} />
      </span>
    </li>
  );
}

// A member mid-round — or done with nothing recorded: a round that ENDED UNSOLVED (`over`:
// given up, or capped) prints `∞` where the tries would be, its % kept quiet, after the live
// rows (the shared `orderPlaying`). No rank: a position mid-round is never a rank claim (#206).
export function PlayingRowItem({
  row,
  me,
  index,
  run,
}: {
  row: PlayingRow;
  me: boolean;
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
            <span className="sr-only">∞</span>
          </>
        ) : (
          <Count value={row.tries} run={run} />
        )}
      </span>
    </li>
  );
}

// A member with no score today (the board screen's NOT PLAYED YET): the person, and nothing
// where a number would be — WHY is said once, by the caption above them.
export function WaitingRowItem({ player, index, run }: { player: BoardPlayer; index: number; run?: LineRun }) {
  return (
    <li className="board-row waiting" style={runStyle(run, index)}>
      <span className="board-norank" aria-hidden="true" />
      <Avatar avatar={player.avatar ?? defaultAvatar(player.publicId)} size={MARK} sharp />
      <Name player={player} />
    </li>
  );
}
