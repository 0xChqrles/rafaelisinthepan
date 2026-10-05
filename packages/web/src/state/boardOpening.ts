// THE BOARD SCREEN'S READ — and its OPENING, started by the tap that opens the screen.
//
// A board is read once per ACTIVATION (`screens/Leaderboard.tsx`): a GROUP's board is the
// authenticated POST naming the group (the server refuses a non-member), GLOBAL the anonymous
// GET widened with the caller's own window through their PUBLIC id. `readBoard` is that read,
// spelled once for both callers below.
//
// The first activation of a visit is the screen's OPENING, and the tap that opens it — the
// header's crown, the race line, a board on the solved screen — already knows which board that
// is. So the read starts THERE, on the press (`startOpening`), and the screen TAKES it on mount
// instead of asking again (`takeOpening`): the same one read, out sooner — the press comes
// before the click, and the click before the screen's mount and the request's signing, which
// puts most answers on screen within the beats the head plays before the podium anyway.
//
// It is the screen's own read, never a cache: taken by an opening of the same board for the
// same identity, language and day within `OPENING_MS` of the press — the press, its click and
// the mount — and never after; a read that FAILED is dropped at once, so the next press asks
// again. Opening the screen stays no trigger (#216): no token, no group read, and nothing here
// ever mints an identity.

import { activeDate, type BoardPeriod, type GroupSummary } from '@whippin/shared';
import { boardUrl, parseBoard, parsePeriodBoard, postBoardBody } from '../api';
import type { AnyBoard } from '../game/boardView';
import { deviceIdentity, identityEpoch, identityEpochOf, type DeviceIdentity } from '../identity';
import { useGameStore } from './gameStore';
import { loadGroups, useGroupsStore } from './groups';
import { adoptSignedOutVerdict } from './signedOutVerdict';

// How long a started opening waits to be taken: a press, its click and the screen's mount, a
// slow press included.
const OPENING_MS = 1_500;

// WHICH board a read is for: a group's (and which of its periods), or GLOBAL — and its key, the
// one the screen keeps its boards under.
export type BoardTarget = { tab: 'global' } | { tab: 'group'; group: string; period: BoardPeriod };
export const boardTargetKey = (target: BoardTarget): string =>
  target.tab === 'global' ? 'global' : `${target.group}:${target.period}`;

// The group the board screen shows: the one last opened, else the first the server lists.
export function openingGroup(groups: readonly GroupSummary[] | null, lastGroupId: string | null): GroupSummary | null {
  return groups === null ? null : (groups.find((group) => group.id === lastGroupId) ?? groups[0] ?? null);
}

// ONE board read. Rejects on any failure (the screen's FAILED, or the board it keeps). A refusal
// still answers for the identity that asked: `unknown_device` signs it out, and `not_member` —
// not a member any more (left elsewhere, removed) — means the LIST is stale, so it is read again.
export async function readBoard(
  lang: string,
  date: string,
  target: BoardTarget,
  identity: DeviceIdentity | null,
): Promise<AnyBoard> {
  if (target.tab === 'group') {
    if (identity === null) throw new Error('no identity for a group board');
    const epoch = identityEpochOf(identity);
    const response = await postBoardBody(boardUrl(lang, date), {
      token: identity.token,
      group: target.group,
      ...(target.period === 'day' ? {} : { period: target.period }),
    });
    if (!response.ok) {
      if (identityEpoch() === epoch) {
        if (response.status === 403) {
          const error = await response.json().then(
            (body: { error?: unknown }) => body.error,
            () => undefined,
          );
          if (error === 'not_member') loadGroups();
        } else {
          await adoptSignedOutVerdict(response, epoch);
        }
      }
      throw new Error(`board answered ${response.status}`);
    }
    const data: unknown = await response.json();
    return target.period === 'day' ? parseBoard(data) : parsePeriodBoard(data);
  }
  const response = await fetch(boardUrl(lang, date, identity?.accountId));
  if (!response.ok) throw new Error(`board answered ${response.status}`);
  return parseBoard(await response.json());
}

// The one opening out, waiting to be taken: what it is for (identity, language, day, board) and
// when its press came.
interface Opening {
  id: string;
  at: number;
  answer: Promise<AnyBoard>;
  failed: boolean;
}
let opening: Opening | null = null;

const openingId = (epoch: string | null, lang: string, date: string, key: string) =>
  `${epoch ?? ''}|${lang}|${date}|${key}`;
const waiting = (id: string): Opening | null =>
  opening !== null && !opening.failed && opening.id === id && Date.now() - opening.at < OPENING_MS
    ? opening
    : null;

// A press that can become a click: the main button of the primary pointer (never a right click,
// nor a second finger).
export const primaryPress = (e: { button: number; isPrimary: boolean }): boolean => e.button === 0 && e.isPrimary;

// The press that opens the board screen: start the read of the board it will open on — the tab
// it is set to (GLOBAL, or the group last opened), today, in this language. Nothing when that
// board is not known yet (the groups list unknown), when there is none to read (no group), or
// when the same opening is already out. Call it on the press AND on the click (a keyboard opens
// with no press); the second finds the first.
export function startOpening(lang: string): void {
  const identity = deviceIdentity();
  const { boardTab, lastGroupId } = useGameStore.getState();
  let target: BoardTarget;
  if (boardTab === 'global') {
    target = { tab: 'global' };
  } else {
    // No token, no group board (#216): a tokenless device's list is the known-empty one.
    const group = identity === null ? null : openingGroup(useGroupsStore.getState().groups, lastGroupId);
    if (group === null) return;
    target = { tab: 'group', group: group.id, period: 'day' };
  }
  const date = activeDate(new Date());
  const id = openingId(identity ? identityEpochOf(identity) : null, lang, date, boardTargetKey(target));
  if (waiting(id)) return;
  const answer = readBoard(lang, date, target, identity);
  const started: Opening = { id, at: Date.now(), answer, failed: false };
  // A failed read is never handed on (the next press asks again) — and never an unhandled
  // rejection: the screen that takes it handles its failure.
  answer.catch(() => {
    started.failed = true;
    if (opening === started) opening = null;
  });
  opening = started;
}

// The board screen's opening read, if the tap that opened it started one for exactly this board
// — and the way to hand it BACK when the activation that took it ends before its answer, to the
// next activation of the same board within `OPENING_MS` of the press (React's development re-run
// of an effect; a visit straight after a screen left at once). Past that window, a turn back or a
// visit reads afresh.
export function takeOpening(
  lang: string,
  date: string,
  key: string,
  epoch: string | null,
): { answer: Promise<AnyBoard>; release: () => void } | null {
  const taken = waiting(openingId(epoch, lang, date, key));
  opening = null;
  if (taken === null) return null;
  return {
    answer: taken.answer,
    release: () => {
      if (opening === null && !taken.failed) opening = taken;
    },
  };
}
