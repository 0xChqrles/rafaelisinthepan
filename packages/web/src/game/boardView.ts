import type { Board, PeriodBoard } from '@whippin/shared';
import type { PodiumShow } from '../components/podium/Podium';
import type { PodiumMode } from '../components/podium/scene';
import { t } from '../i18n';
import type { LangCode } from '../langs';
import type { BoardTab } from '../state/gameStore';
import { NO_PLACES, dayPodium, periodPodium } from './podium';

// THE BOARD SCREEN'S READINGS (pure, tested) of the board it shows: whether it draws lines at
// all or its empty state, whether its lines carry numbers, which line is yours, and what its
// podium shows. The screen draws what these say; the rows themselves come ranked from the server.

export type AnyBoard = Board | PeriodBoard;

export const isPeriodBoard = (board: AnyBoard): board is PeriodBoard => 'from' in board;

// A board on screen, as these readings need it: its key, the board, and the tab it was read for.
export interface ShownBoard {
  key: string;
  board: AnyBoard;
  tab: BoardTab;
}

// Whether a board draws its podium and LINES rather than its empty state (the podium's ghost).
// Empty is per TAB. The GLOBAL board is empty when nobody played. A GROUP's
// board is empty when the caller is ALONE in it: the server includes the caller's own row
// once they played, and a board of exactly yourself still means "nobody else yet", which is
// what the ghost says and INVITE remedies (a member who merely has not played is a waiting
// row, never empty). A period is empty when nobody in the group recorded a score in it.
export function hasLines(board: AnyBoard, tab: BoardTab, meId: string | null): boolean {
  if (isPeriodBoard(board)) return board.rows.length > 0;
  const others = board.rows.filter((row) => row.publicId !== meId);
  const playingOthers = board.playing.filter((row) => row.publicId !== meId);
  return !(
    (tab === 'group' ? others.length === 0 && playingOthers.length === 0 : board.rows.length === 0) &&
    (board.own?.length ?? 0) === 0 &&
    board.waiting.length === 0
  );
}

// Whether a board's lines carry numbers.
export function listCounts(board: AnyBoard): boolean {
  if (isPeriodBoard(board)) return board.rows.length > 0;
  return board.rows.length > 0 || (board.own?.length ?? 0) > 0 || board.playing.length > 0;
}

// Which line of a board is yours, and where (ranked, and at which rank, or playing): the
// held-edge watch starts again whenever it changes — a re-read bringing your line, your row
// turning from playing to ranked.
export function ownLineKey(shown: ShownBoard | null, meId: string | null): string {
  if (!shown || !meId) return '';
  const board = shown.board;
  if (isPeriodBoard(board)) return `p${board.rows.find((row) => row.publicId === meId)?.rank ?? ''}`;
  const ranked = [...board.rows, ...(board.own ?? [])].find((row) => row.publicId === meId);
  if (ranked) return `r${ranked.rank}`;
  return board.playing.some((row) => row.publicId === meId) ? 'playing' : '';
}

// WHAT THE PODIUM SHOWS for the body's state: a failure, no group at all, a read still out, an
// empty board (the ghost) — or the board's first three rows on their places (`podium.ts`:
// never re-ranked), each with the unit its value counts in. Its `build` names the picture: a
// board whose podium changes is a new scene, one shown before is the same.
export function podiumShows({
  failed,
  none,
  shown,
  meId,
  mates,
  lang,
}: {
  failed: boolean;
  none: boolean;
  shown: ShownBoard | null;
  meId: string | null;
  mates: ReadonlySet<string>;
  lang: LangCode;
}): PodiumShow {
  const still = (build: string, mode: PodiumMode) => ({ build, mode, places: NO_PLACES, seedKey: '' });
  if (failed) return still('failed', 'failed');
  if (none) return still('none', 'ghost');
  if (!shown) return still('loading', 'loading');
  if (!hasLines(shown.board, shown.tab, meId)) return still(`${shown.key}:empty`, 'ghost');
  const board = shown.board;
  const period = isPeriodBoard(board);
  const picked = period ? periodPodium(board.rows).places : dayPodium(board.rows).places;
  const unit = (value: number) => t(lang, period ? (value === 1 ? 'point' : 'points') : value === 1 ? 'try' : 'tries');
  const places = picked.map((place) =>
    place
      ? {
          player: place.row,
          rank: place.rank,
          value: place.value,
          unit: unit(place.value),
          near: place.near,
          me: place.row.publicId === meId,
          // Only GLOBAL marks the reader's people (on a group's board every row is one).
          mate: shown.tab === 'global' && place.row.publicId !== meId && mates.has(place.row.publicId),
        }
      : null,
  );
  const id = places.map((p) =>
    p ? `${p.player.publicId}:${p.rank}=${p.value}${p.me ? '*' : ''}${p.mate ? '+' : ''}` : '-',
  );
  return { build: `${shown.key}|${id.join(',')}`, mode: 'board', places, seedKey: shown.key };
}
