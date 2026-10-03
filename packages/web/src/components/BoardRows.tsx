// A board's ROWS — one player each — drawn by every surface that lists players on a day: the
// leaderboard screen and the solved screen's boards. One component per row kind, so the two
// surfaces cannot say one player two ways; each surface DRESSES them in its own CSS (the board's
// glass rows, the result's lines of type on the bare ground). `mark` is the avatar's size and
// `sharp` its corners: the board's rounded 28px, the result's square 30px (3px a cell, among
// pixel type).
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
import InfinityGlyph from './InfinityGlyph';
import CrownIcon from '../assets/icons/board.svg?react';
import { shownPercent } from '../game/race';

const MARK = 28;

// A row's rank: the number in the quiet pixel face (the board screen prints it `#N`, a CSS
// dress) — and FIRST PLACE WEARS THE CROWN instead, the header's own board mark in the accent
// (the palette's "every solved word/trophy/terminus" blue). Competition ranks share a first,
// so a tie crowns every row that holds it. The number stays for a screen reader.
export function BoardRank({ rank }: { rank: number }) {
  if (rank !== 1) return <span className="board-rank">{rank}</span>;
  return (
    <span className="board-rank crown">
      <CrownIcon className="ui-icon" aria-hidden />
      <span className="sr-only">#1</span>
    </span>
  );
}

export function BoardRowItem({
  row,
  me,
  mate = false,
  index,
  mark = MARK,
  sharp = false,
}: {
  row: BoardRow;
  me: boolean;
  mate?: boolean;
  index: number;
  mark?: number;
  sharp?: boolean;
}) {
  return (
    <li
      // `me` wins over `mate`: your own row is never one of your people, but a stale list
      // could say so, and two markers on one row is a rendering bug on screen.
      className={`board-row${me ? ' me' : mate ? ' mate' : ''}`}
      style={{ '--i': index } as CSSProperties}
      aria-current={me || undefined}
    >
      <BoardRank rank={row.rank} />
      <Avatar avatar={row.avatar ?? defaultAvatar(row.publicId)} size={mark} sharp={sharp} />
      <span className={`board-name${row.name ? '' : ' anon'}`}>{row.name || anonName(row.publicId)}</span>
      <span className="board-score">{row.score}</span>
    </li>
  );
}

// A member mid-round — or done with nothing recorded: a round that ENDED UNSOLVED (`over`:
// given up, or capped) prints `∞` where the tries would be, its % kept quiet, after the live
// rows (the shared `orderPlaying`).
export function PlayingRowItem({
  row,
  me,
  index,
  mark = MARK,
  sharp = false,
}: {
  row: PlayingRow;
  me: boolean;
  index: number;
  mark?: number;
  sharp?: boolean;
}) {
  return (
    <li
      className={`board-row playing${row.over ? ' over' : ''}${me ? ' me' : ''}`}
      style={{ '--i': index, '--play-heat': progressHeatColor(row.progress) } as CSSProperties}
      aria-current={me || undefined}
    >
      <span className="board-norank" aria-hidden="true" />
      <Avatar avatar={row.avatar ?? defaultAvatar(row.publicId)} size={mark} sharp={sharp} />
      <span className={`board-name${row.name ? '' : ' anon'}`}>{row.name || anonName(row.publicId)}</span>
      <span className="board-progress">{shownPercent(row.progress)}%</span>
      <span className="board-score">
        {row.over ? (
          <>
            <InfinityGlyph className="board-inf" />
            <span className="sr-only">∞</span>
          </>
        ) : (
          row.tries
        )}
      </span>
    </li>
  );
}

export function WaitingRowItem({ player, index }: { player: BoardPlayer; index: number }) {
  return (
    <li className="board-row waiting" style={{ '--i': index } as CSSProperties}>
      <span className="board-norank" aria-hidden="true" />
      <Avatar avatar={player.avatar ?? defaultAvatar(player.publicId)} size={MARK} />
      <span className={`board-name${player.name ? '' : ' anon'}`}>{player.name || anonName(player.publicId)}</span>
    </li>
  );
}
