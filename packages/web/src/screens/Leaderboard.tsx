import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  anonName,
  dateForDayNumber,
  defaultAvatar,
  type Board,
  type BoardPeriod,
  type BoardPlayer,
  type BoardRow,
  type GroupSummary,
  type PeriodBoard,
  type PeriodRow,
} from '@whippin/shared';
import {
  boardUrl,
  groupsUrl,
  parseBoard,
  parseGroups,
  parsePeriodBoard,
  postBoardBody,
  postGroupsBody,
  readGroup,
  type GroupsBody,
} from '../api';
import Avatar from '../components/Avatar';
import BoardTabs, { type BoardTab as Scope } from '../components/BoardTabs';
import ConfirmScreen from '../components/ConfirmScreen';
import { BoardRank, BoardRowItem, PlayingRowItem, WaitingRowItem, type LineRun } from '../components/BoardRows';
import { LINE_PX, MARK } from '../components/boardMetrics';
import { DISSOLVES, EDGES } from '../components/bayerTiles';
import GroupCreate from '../components/GroupCreate';
import GroupScreen from '../components/GroupScreen';
import LoadError from '../components/LoadError';
import PeriodSwitch from '../components/PeriodSwitch';
import Podium, { NO_PLACES, nextStage, type PodiumEntry, type PodiumStage } from '../components/Podium';
import { beats, podiumHeightPx, podiumSize, type PodiumMode, type PodiumSize } from '../components/podium/scene';
import PuzzleTitle from '../components/PuzzleTitle';
import ReelNumber from '../components/ReelNumber';
import { HeaderLeft } from '../components/TopBar';
import ChevronIcon from '../assets/icons/chevron-left.svg?react';
import useShare from '../hooks/useShare';
import useSwipe from '../hooks/useSwipe';
import useToday from '../hooks/useToday';
import { prefersReducedMotion } from '../hooks/useScramble';
import {
  ensureRequestIdentity,
  identityEpoch,
  identityEpochOf,
  useDeviceIdentity,
} from '../identity';
import { adoptGroups, loadGroups, useGroups } from '../state/groups';
import { adoptSignedOutVerdict } from '../state/signedOutVerdict';
import { prefetchTurnstileTokens } from '../turnstile';
import ErrorScreen from '../components/ErrorScreen';
import { useGameStore, type BoardTab } from '../state/gameStore';
import { pathForGroupInvite, type LangCode } from '../langs';
import { dayPodium, periodPodium } from '../game/podium';
import { t } from '../i18n';

// The #190 leaderboard screen, drawn over GROUPS since #271 (user-decided 2026-09-07:
// groups replace the friends graph — a pair of friends is a group of two). The boards are
// per (day, lang), for the active day. A GROUP is the DEFAULT and the trusted
// surface — the whole point of the design (#187's anti-cheat stance: trust comes from the
// people you chose, not the global list) — with the GLOBAL top 50 as the last tab,
// explicitly the fun/untrusted view. A group has THREE boards: the DAY (finished,
// playing, waiting — the live one), and the WEEK and MONTH ranked by the shared period
// rule (podium points, then solved days, then fewer tries). This screen is also where a
// player CREATES a group, INVITES into it (the `/g/<id>` link), LEAVES it, and — as its
// owner — shows a member out.
//
// THE SCREEN IS THE RESULT'S BOARDS GIVEN THE WHOLE COLUMN: the same bare ground, the same
// lines of type (`BoardRows`), the same control. WHICH BOARD is the boards' one TAB ROW
// (`BoardTabs` — the solved screen's own): every group's name, then GLOBAL, the white chip on
// the one shown and TRAVELLING to the next; a sideways swipe on the lines turns it too. A tap
// on the shown group's chip goes INTO the group — its own screen (`GroupScreen`: INVITE, the
// owner's ✕ on every other member, LEAVE) — and so does the DOOR heading its list, the
// group's size as a quiet word; the row's pinned PLUS names a new group (`GroupCreate`). The
// board itself carries no standing button ("3 huge thick buttons always on screen even if we
// use them 1% of the time"). A group has THREE boards — TODAY, WEEK, MONTH — on the line under
// the tabs (`PeriodSwitch`: three words, the shown one framed by the corner brackets). LEAVING
// and REMOVING confirm on a FULL-SCREEN modal (`ConfirmScreen`), and the owner's leave carries
// the SUCCESSION the server demands (root AGENTS.md, Groups): alone, the group is deleted;
// with one other member that member takes it; with more, the owner picks one here.
//
// THE BOARD HAS A SUBJECT, the way the result has its count: its PODIUM (`Podium`), the top
// three standing on their steps between the head and the lines — first place's count in the
// FOIL, the screen's one shiny thing — and the lines under it start at the fourth. The first
// time a board is shown in a visit the podium BUILDS (its steps rising, its players dropping
// onto them, the values landing on the result count's reels and first place's cobalt
// dissolving into the foil — the result's own gesture) and its lines follow it in, one after
// another through the Bayer dissolve (CSS `board-dissolve`), their numbers on the same reels
// (`ReelNumber`); a board turned back to is SETTLED, its lines simply dissolving in. The
// first board on screen ARRIVES (after the head's own beats); every board turned to after it
// comes in quicker, and GIVES WAY to the one before slot by slot — the one before keeping
// every slot until the new one's line dissolves in through it — so no frame of a turn is a
// bare list; a read that keeps it waiting long lets it give way to the loading picture
// instead (a podium crowning another tab's winner says something false). Every box is laid
// out from its first frame — the podium's the same height in every state, its size chosen
// off the room the screen has (none at all where it would leave the lines none: they start
// at the first, crowned, in the result's dress) — so nothing that has landed moves; reduced
// motion draws the board landed.
//
// The rows come ranked from the server (competition ties, the plain top-50 cut, the
// own-row window, the period rule — @whippin/shared's leaderboard rules); this screen only
// draws what the API returned, the podium being its first three rows (`game/podium.ts`). Rows
// CONNECTED to the reader stay apart: your own line is FRAMED by the corner brackets (and stays
// in sight on a long board, held to the column's edge while it is scrolled out of view), on
// the podium your name is and your place is in the accent; among the global rows, a member of
// one of your groups carries a small accent mark.
//
// **OPENING THIS SCREEN IS NOT A TRIGGER (user-decided 2026-08-24).** A navigation must not
// create server state: tokenless, the groups list is the KNOWN-EMPTY answer (#216's rule)
// and the global read stays anonymous. The deliberate acts that mint are NEW GROUP and
// INVITE, and every identity-reading effect keys on the live identity, so a mint (or a
// cross-tab adoption) populates the screen without a remount.
type AnyBoard = Board | PeriodBoard;

const isPeriodBoard = (board: AnyBoard): board is PeriodBoard => 'from' in board;

// The succession a LEAVE carries, read off the list the server last answered (the same
// rule the server applies — `successionFor`; root AGENTS.md, Groups): a member who is not
// the owner hands nothing over (`plain`); an owner alone deletes the group (`last`); an
// owner of two hands it to the other member (`handover`); an owner of three or more must
// NAME a member (`pick`).
export type LeaveKind = 'plain' | 'last' | 'handover' | 'pick';

export function leaveKindOf(group: GroupSummary | null, meId: string | null): LeaveKind {
  if (group === null || group.createdBy !== meId) return 'plain';
  const others = group.members.filter((id) => id !== meId);
  return others.length === 0 ? 'last' : others.length === 1 ? 'handover' : 'pick';
}

// What the LEAVE puts on the wire: the successor travels only when the owner had to pick
// one — every other leave is the group's id alone.
export function leaveBody(token: string, group: string, kind: LeaveKind, successor: string | null): GroupsBody {
  const named = kind === 'pick' ? successor : null;
  return { token, leave: group, ...(named ? { successor: named } : {}) };
}

export default function Leaderboard({ lang }: { lang: LangCode }) {
  // The tab belongs to the VISIT (user feedback 2026-08-20): it lives in the store because
  // this screen remounts without the visit ending, and App resets it on any non-board route.
  const tab: BoardTab = useGameStore((s) => s.boardTab);
  const setTab = useGameStore((s) => s.setBoardTab);
  // WHICH group: the one last opened (persisted, account-owned), else the first the
  // server lists.
  const lastGroupId = useGameStore((s) => s.lastGroupId);
  const setLastGroup = useGameStore((s) => s.setLastGroup);
  const [period, setPeriod] = useState<BoardPeriod>('day');

  const identity = useDeviceIdentity();
  const epoch = identity ? identityEpochOf(identity) : null;
  const meId = identity?.accountId ?? null;

  // The player's groups — the pages. Read off the ONE cache every group surface shares;
  // tokenless it is known-empty without a request.
  const { phase: groupsPhase, groups } = useGroups();
  useEffect(() => {
    loadGroups();
  }, [identity]);
  const active: GroupSummary | null =
    groups === null
      ? null
      : (groups.find((group) => group.id === lastGroupId) ?? groups[0] ?? null);
  // The reader's own people, for marking rows among the global ones: the union of every
  // group they are in, which the list already carries.
  const mates = new Set(groups?.flatMap((group) => group.members) ?? []);

  // THE SCOPES, in the tab row's order: every group — or, with none, the one tab that SAYS
  // so (a state, not a name: `bare`, no chip; its body carries CREATE GROUP) — then GLOBAL,
  // pinned at the row's end (every player has it, however long the groups' names run).
  const scopes: Scope[] =
    groups === null
      ? []
      : [
          ...groups.map((group) => ({ key: group.id, label: group.name })),
          ...(groups.length === 0 ? [{ key: 'none', label: t(lang, 'boardEmptyGroups'), bare: true }] : []),
          { key: 'global', label: t(lang, 'boardGlobal'), pinned: true },
        ];
  // "No group" is an ANSWER, never the wait for one: while the list is unknown (null) the
  // body is LOADING, so a player who has groups never sees CREATE GROUP flash first.
  const onNone = tab === 'group' && groups?.length === 0;
  const activeIndex =
    scopes.length === 0
      ? 0
      : tab === 'global'
        ? scopes.length - 1
        : active === null
          ? 0
          : Math.max(0, scopes.findIndex((scope) => scope.key === active.id));
  const showScope = (index: number) => {
    const scope = scopes[index];
    if (!scope) return;
    if (scope.key === 'global') {
      setTab('global');
    } else {
      if (scope.key !== 'none') setLastGroup(scope.key);
      setTab('group');
    }
  };

  // ONE outcome slot per board — a board, or that board's own failure — keyed by what it
  // shows. Screen-global failure state would paint a FAILED frame over another board's
  // perfectly good rows for a render when flipping back.
  const boardKey = tab === 'global' ? 'global' : active ? `${active.id}:${period}` : null;
  const [boards, setBoards] = useState<Partial<Record<string, AnyBoard | 'failed'>>>({});
  const [attempt, setAttempt] = useState(0);
  // THE BOARD ON SCREEN — the last one resolved, HELD while the next one's first read is out,
  // so a turn to a board not read yet keeps its lines (and the door over them) until the new
  // lines dissolve in over them: a read lands as one board giving way to the next, never as a
  // blank column. HELD FOR HOLD_MS AT MOST: a read that outlasts it (`lapsed`, the key it was
  // for) lets the board before give way to the loading picture — a held board under another
  // tab's name says something false, and a podium says it loudly. Same cache scope as `boards`
  // (dropped with it below).
  const [held, setHeld] = useState<Shown | null>(null);
  const [lapsed, setLapsed] = useState<string | null>(null);
  // WHAT THE PODIUM HAS BUILT this visit (its scenes' identities): a board shown again is that
  // board, settled — its build is never replayed on a turn back (that would be a wait, and would
  // move what had landed). Same cache scope as `boards`.
  const played = useRef(new Set<string>());

  // THE DAY IS A LIVE VALUE: a board is left open across the 22:00-ET flip routinely, and a
  // new day is a new board, so every cache goes with it — dropped during render so
  // yesterday's rows are never committed under today's date.
  const date = dateForDayNumber(useToday());
  const [cachedDate, setCachedDate] = useState(date);
  // (This render still reads the dropped caches: nothing is taken from them below.)
  let dropped = false;
  if (cachedDate !== date) {
    setCachedDate(date);
    setBoards({});
    setHeld(null);
    setLapsed(null);
    played.current.clear();
    dropped = true;
  }
  // AND THE CACHES ARE IDENTITY-SCOPED: a board cached under a previous identity is not the
  // current account's answer, and the stale-but-good rule below would keep it over a failed
  // refresh. A scope change drops everything, exactly as a new day does.
  const [cachedEpoch, setCachedEpoch] = useState(epoch);
  if (cachedEpoch !== epoch) {
    setCachedEpoch(epoch);
    setBoards({});
    setHeld(null);
    setLapsed(null);
    played.current.clear();
    dropped = true;
  }

  // One fetch per board ACTIVATION — the route is a zero-TTL live read, so a page turn
  // re-reads rather than trusting a snapshot; the cached board holds the screen while the
  // fresh one is in flight (stale-but-good beats a spinner), and RETRY refetches. A GROUP
  // board is the authenticated POST naming the group (the server refuses a non-member);
  // GLOBAL is the anonymous GET, widened with the caller's own window via their PUBLIC id.
  useEffect(() => {
    if (boardKey === null) return;
    const key = boardKey;
    let cancelled = false;
    setBoards((prev) => (prev[key] === 'failed' ? { ...prev, [key]: undefined } : prev));
    // No token, no private fetch (#216): a group page cannot exist tokenless (the list is
    // empty), so only the global read runs without an identity.
    if (tab === 'group' && !identity) return;
    (async () => {
      const epochNow = identity ? identityEpochOf(identity) : null;
      try {
        let board: AnyBoard;
        if (tab === 'group' && identity !== null && active !== null) {
          const response = await postBoardBody(boardUrl(lang, date), {
            token: identity.token,
            group: active.id,
            ...(period === 'day' ? {} : { period }),
          });
          if (cancelled || (epochNow !== null && identityEpoch() !== epochNow)) return;
          if (!response.ok) {
            await adoptSignedOutVerdict(response, epochNow ?? '');
            // Not a member any more (left elsewhere, removed): the list is what is stale.
            if (response.status === 403) loadGroups();
            throw new Error(`board answered ${response.status}`);
          }
          const data: unknown = await response.json();
          board = period === 'day' ? parseBoard(data) : parsePeriodBoard(data);
        } else {
          const response = await fetch(boardUrl(lang, date, identity?.accountId));
          if (cancelled || (epochNow !== null && identityEpoch() !== epochNow)) return;
          if (!response.ok) throw new Error(`board answered ${response.status}`);
          board = parseBoard(await response.json());
        }
        if (!cancelled && (epochNow === null || identityEpoch() === epochNow)) {
          setBoards((prev) => ({ ...prev, [key]: board }));
        }
      } catch {
        // FAILED only when there is nothing to show: an error frame over rows already on
        // screen helps nobody — the cached board stands until a refresh succeeds.
        if (!cancelled && (epochNow === null || identityEpoch() === epochNow)) {
          setBoards((prev) =>
            prev[key] && prev[key] !== 'failed' ? prev : { ...prev, [key]: 'failed' },
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // `active?.id` rather than `active`: the list object is re-read, the group is not.
  }, [boardKey, tab, active?.id, period, lang, date, attempt, identity]);

  const entry = boardKey === null ? undefined : boards[boardKey];
  const board = entry === 'failed' ? undefined : entry;

  // ---- the deliberate acts: CREATE, INVITE, LEAVE, REMOVE — on the group's own screens,
  // never on the board. Each write answers the list as it now stands, published through
  // `adoptGroups`; a failure lands on the app's error surface, since saying nothing leaves
  // the player tapping a button that appears to do nothing.
  const [busy, setBusy] = useState<'create' | 'invite' | 'leave' | 'remove' | null>(null);
  const [failure, setFailure] = useState<'account' | 'share' | 'group' | 'limit' | null>(null);
  // WHICH SCREEN is up over the board, and WHICH CONFIRMATION over that.
  const [screen, setScreen] = useState<'group' | 'create' | null>(null);
  const [confirming, setConfirming] = useState<{ kind: 'remove'; member: BoardPlayer } | { kind: 'leave' } | null>(null);
  const [successor, setSuccessor] = useState<string | null>(null);
  // The members DRESSED (name + mark) for the successor picker: the list carries ids
  // alone, and `GET /groups?id=` is the public face that names them. Decoration — until
  // it lands, and if it never does, the rows wear the assigned identities.
  const [faces, setFaces] = useState<Record<string, BoardPlayer>>({});
  const { share, copied } = useShare({ tracked: false });
  useEffect(() => {
    if (identity === null) prefetchTurnstileTokens(1);
  }, [identity]);

  // ONE gesture for every write: the deploy (a tokenless tap mints the account first, the
  // button holding its loading state for both legs), then the signed POST, then the list.
  const write = async (
    kind: NonNullable<typeof busy>,
    body: (token: string) => Parameters<typeof postGroupsBody>[1],
  ): Promise<{ ok: true; created?: string } | { ok: false; error: string | null }> => {
    setBusy(kind);
    setFailure(null);
    try {
      let request;
      try {
        request = await ensureRequestIdentity(epoch);
      } catch {
        setFailure('account');
        return { ok: false, error: null };
      }
      if (!request) return { ok: false, error: null };
      const response = await postGroupsBody(groupsUrl(), body(request.identity.token));
      if (identityEpoch() !== request.epoch) return { ok: false, error: null };
      if (!response.ok) {
        await adoptSignedOutVerdict(response, request.epoch);
        let error: string | null = null;
        try {
          error = String(((await response.clone().json()) as { error?: unknown }).error ?? '');
        } catch {
          error = null;
        }
        setFailure(error === 'group_limit' ? 'limit' : 'group');
        return { ok: false, error };
      }
      const answer = parseGroups(await response.json());
      adoptGroups(answer, request.identity.accountId);
      return { ok: true, created: answer.created };
    } catch {
      setFailure('group');
      return { ok: false, error: null };
    } finally {
      setBusy(null);
    }
  };

  // The create screen closes ITSELF once the group exists (it plays the name inked in
  // first); the board is already on the new group when it does.
  const create = async (name: string): Promise<boolean> => {
    if (busy) return false;
    const result = await write('create', (token) => ({ token, create: true, name }));
    if (result.ok && result.created) {
      setLastGroup(result.created);
      setTab('group');
      setPeriod('day');
      return true;
    }
    return false;
  };

  // The invite link is both "join us" and "come play": one line of copy, then the URL.
  // Delivery (native sheet -> clipboard + COPIED) is useShare's, like every result.
  const invite = async () => {
    if (busy || !active) return;
    setFailure(null);
    const delivered = await share(
      `${t(lang, 'boardInviteText')}\n${window.location.origin}${pathForGroupInvite(active.id)}`,
    );
    if (!delivered) setFailure('share');
  };

  // The succession the LEAVE carries: who else is in the group decides whether the owner
  // names somebody. A list gone stale by the time the tap lands is the server's 409
  // `successor_required`, which re-reads the list below.
  const others = active ? active.members.filter((id) => id !== meId) : [];
  const leaveKind = leaveKindOf(active, meId);

  // Opening the owner's leave with a choice to make DRESSES the candidates.
  useEffect(() => {
    if (confirming?.kind !== 'leave' || leaveKind !== 'pick' || !active) return;
    const controller = new AbortController();
    void readGroup(active.id, controller.signal).then((read) => {
      if (read.status !== 'shown' || controller.signal.aborted) return;
      setFaces(Object.fromEntries(read.group.members.map((member) => [member.publicId, member])));
    });
    return () => controller.abort();
    // Deliberately `active?.id`, not `active`: the list object is re-read, the group is not.
  }, [confirming?.kind, leaveKind, active?.id]);

  const leave = async () => {
    if (busy || !active) return;
    if (leaveKind === 'pick' && successor === null) return;
    const id = active.id;
    const result = await write('leave', (token) => leaveBody(token, id, leaveKind, successor));
    setConfirming(null);
    setSuccessor(null);
    if (result.ok) {
      setScreen(null);
    } else if (result.error === 'successor_required') {
      // The list this screen decided from was stale: re-read it, and the next LEAVE asks.
      loadGroups();
    }
  };

  const remove = async (member: string) => {
    if (busy || !active) return;
    const result = await write('remove', (token) => ({ token, remove: active.id, member }));
    setConfirming(null);
    if (result.ok) setAttempt((n) => n + 1);
  };

  // INTO the group shown: its own screen (the list refreshed on the way in).
  const openGroup = () => {
    if (tab !== 'group' || active === null) return;
    loadGroups();
    setScreen('group');
  };
  // A sideways swipe on the lines turns the tab row; its click opens nothing.
  const { handlers: swipe, swiped } = useSwipe((step) => showScope(activeIndex + step));

  const bodyRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);

  // HOW THE LINES COME IN: the first board on screen ARRIVES, every board turned to after it
  // TURNS in, quicker (see the header). Latched as STATE, set during render (React's own way
  // to derive from a prop change — a discarded render latches nothing): the first key that
  // resolved, and whether the screen has turned off it since.
  // (Read through to this render's own values, so the board resolving now is paced by them.)
  const [firstKey, setFirstKey] = useState<string | null>(null);
  const [turned, setTurned] = useState(false);
  const first = firstKey ?? (!dropped && board && boardKey !== null ? boardKey : null);
  const away = turned || (first !== null && boardKey !== first);
  if (first !== firstKey) setFirstKey(first);
  if (away !== turned) setTurned(away);
  const pace = boardKey === first && !away ? ARRIVE : TURN;
  // A board resolving takes the screen (it keeps the pace it came in at across refreshes of
  // its own key, so a re-read never re-times its lines).
  if (!dropped && board && boardKey !== null && (held?.key !== boardKey || held.board !== board)) {
    setHeld({
      key: boardKey,
      board,
      tab,
      group: tab === 'group' ? (active?.id ?? null) : null,
      pace: held?.key === boardKey ? held.pace : pace,
    });
  }
  // A read out for another board than the one held: the hold's clock.
  // (On the page's animation clock, as every beat of the screen is.)
  const holding = boardKey !== null && held !== null && held.key !== boardKey && entry === undefined;
  useEffect(() => {
    if (!holding || boardKey === null) return undefined;
    return onClock(columnRef.current, HOLD_MS, () => setLapsed(boardKey));
  }, [holding, boardKey]);
  // What the body draws: that board — or, while this one's read is out (and not for long), the
  // one held.
  const shown = entry === 'failed' || (held !== null && held.key !== boardKey && lapsed === boardKey) ? null : held;
  // What is on screen is not yet what was asked for.
  const pending = boardKey !== null && entry !== 'failed' && shown?.key !== boardKey;
  // The group the board on screen belongs to — its door, its size — so the door, the podium and
  // the lines always say the same group (a failed read's door is the group asked for).
  const shownGroup =
    shown !== null
      ? shown.tab === 'group'
        ? (groups?.find((group) => group.id === shown.group) ?? null)
        : null
      : entry === 'failed' && tab === 'group'
        ? active
        : null;

  // THE ROOM, measured: the body's height in whole lines and its width — the podium's size
  // follows it (`podiumSize`: roomy, compact, or none at all where it would leave the lines no
  // room), with a line's grace for the size it has, so a phone's toolbar never flips it.
  const [room, setRoom] = useState<{ slots: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return undefined;
    const measure = () => {
      const next = { slots: Math.floor(body.clientHeight / LINE_PX), width: body.clientWidth };
      setRoom((was) => (was && was.slots === next.slots && was.width === next.width ? was : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(body);
    return () => ro.disconnect();
  }, []);
  const [size, setSize] = useState<PodiumSize | null>(null);
  const sizeNow = room ? podiumSize(room.width, room.slots, size) : size;
  if (sizeNow !== size) setSize(sizeNow);

  // THE PODIUM: what it shows — the board's top three, or the state the body is in, each its
  // own picture in its one box — latched as a STAGE whenever that changes, read off the stage
  // before it (`nextStage`: whether it builds, who stays, which values run again), so the
  // lines under it are timed off the very beats it plays. A board builds the first time it is
  // shown in the visit; the first board ARRIVES, leaving the head its beats.
  const now = podiumShows({
    failed: (tab === 'group' && groupsPhase === 'failed' && groups === null) || entry === 'failed',
    none: tab === 'group' && onNone,
    shown,
    meId,
    mates,
    lang,
  });
  const [stage, setStage] = useState<PodiumStage | null>(null);
  let staged = stage;
  const shownPace = shown?.pace ?? ARRIVE;
  if (staged === null || staged.build !== now.build) {
    staged = nextStage(
      stage,
      now,
      now.mode === 'board' && !played.current.has(now.build),
      shownPace === ARRIVE ? shownPace.startMs : 0,
      shownPace.runMs,
    );
    setStage(staged);
  }
  const tl = useMemo(() => beats(staged.spec), [staged]);
  useEffect(() => {
    if (staged.mode === 'board') played.current.add(staged.build);
  }, [staged]);

  // THE COLUMN SCROLLS AS ONE — the podium, the list's header, the lines — so a long board
  // carries the podium away and the reader down to their own line. Its height is the body's
  // room in WHOLE LINES (the podium and the header are whole slots too), so it rests on whole
  // lines (its scroll snaps to them) and your line held at its edge covers exactly one — never
  // half a name. Its count also says where the FOLD is: the slots past it come in with the
  // last one on screen.
  const slots = room?.slots ?? 0;
  const fold = slots > 0 ? Math.max(0, Math.min(PACE_CAP, slots - (size ? podiumHeightPx(size) / LINE_PX : 0) - 1)) : PACE_CAP;
  // How the lines come in: on the podium's own beat (on their own, with no podium), quicker on
  // a turn, their numbers on the reels only where the board is shown for the first time (a
  // board shown again is settled: its lines dissolve in, their numbers standing).
  const run: ListRun = {
    pace: {
      startMs: size ? tl.lines : shownPace.startMs,
      staggerMs: shownPace.staggerMs,
      runMs: staged.spec.build ? shownPace.runMs : 0,
    },
    fold,
  };
  // A board turned to opens at its top.
  useLayoutEffect(() => {
    if (columnRef.current) columnRef.current.scrollTop = 0;
  }, [shown?.key]);

  // WHAT STANDS UNDER THE PODIUM (`Under`): a group's header slot — its door, and the unit
  // when nothing above says it — then the lines, the skeleton, or (with no podium) the empty
  // board's own block. A new one GIVES WAY to the one before slot by slot: the one before
  // stays (`out`) and each of its slots dissolves out through exactly the cells the new one's
  // slot dissolves in through, on the new one's beat — so no frame of a turn is a bare list.
  const holdKind = now.mode === 'failed' || now.mode === 'ghost' ? now.mode : null;
  const viewTab = shown?.tab ?? tab;
  const sub = viewTab === 'group' || size === null;
  const counts =
    shown !== null &&
    now.mode === 'board' &&
    (size === null || staged.places.every((place) => place === null)) &&
    listCounts(shown.board);
  const view: UnderView = {
    key: holdKind
      ? `${holdKind}:${now.build}:${size ?? ''}`
      : shown
        ? `list:${shown.key}:${size ?? ''}`
        : `skeleton:${viewTab}`,
    sub,
    door: sub && shownGroup ? shownGroup.members.length : null,
    unit: counts && shown ? (isPeriodBoard(shown.board) ? 'points' : 'tries') : null,
    body: holdKind ? (size ? null : 'hold') : shown ? 'list' : 'skeleton',
    shown: holdKind ? null : shown,
    shownFor: 0,
  };
  // The view on screen (its key, since when), and the one before giving way under it, on the
  // run of the one it gives way to.
  const lastView = useRef(view);
  const [under, setUnder] = useState<{ key: string; since: number; out: UnderView | null; outRun: ListRun }>(() => ({
    key: view.key,
    since: clockNow(),
    out: null,
    outRun: run,
  }));
  if (under.key !== view.key) {
    const was = lastView.current;
    const at = clockNow();
    setUnder({
      key: view.key,
      since: at,
      out:
        !prefersReducedMotion() &&
        was.key === under.key &&
        (was.body === 'list' || was.body === 'skeleton' || was.door !== null)
          ? { ...was, shownFor: at - under.since }
          : null,
      outRun: run,
    });
  }
  useLayoutEffect(() => {
    lastView.current = view;
  });
  // The one before is gone once its last slot has dissolved out (on the page's animation
  // clock, as the dissolve itself is).
  useEffect(() => {
    const out = under.out;
    if (!out) return undefined;
    return onClock(columnRef.current, lineRun(under.outRun, under.outRun.fold).delayMs + DISSOLVE_MS, () =>
      setUnder((now) => (now.out === out ? { ...now, out: null } : now)),
    );
  }, [under.out, under.outRun]);
  useStuckOwnLine(columnRef, `${view.key}|${now.build}|${ownLineKey(shown, meId)}`);

  const ghostLine =
    now.mode === 'ghost' && !onNone && shown ? (
      <p>
        {t(lang, isPeriodBoard(shown.board) ? 'boardEmptyPeriod' : shown.tab === 'group' ? 'boardEmptyGroup' : 'boardEmptyGlobal')}
      </p>
    ) : null;
  // The empty board's one call: CREATE GROUP with no group at all; INVITE in a group of one
  // (the moment it matters).
  const ghostCall =
    now.mode !== 'ghost' ? null : tab === 'group' && onNone ? (
      <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => setScreen('create')}>
        {t(lang, 'groupCreate')}
      </button>
    ) : shown && shown.tab === 'group' && !isPeriodBoard(shown.board) ? (
      <button type="button" className="btn btn-primary" onClick={() => void invite()}>
        {copied ? t(lang, 'copied') : t(lang, 'boardInvite')}
      </button>
    ) : null;
  const retry =
    now.mode === 'failed' ? (
      <LoadError
        message={t(lang, 'failedBoard')}
        lang={lang}
        onRetry={() => (entry === 'failed' ? setAttempt((n) => n + 1) : loadGroups())}
      />
    ) : null;
  const underProps = {
    lang,
    meId: meId ?? undefined,
    mates,
    places: size ? staged.places : null,
    onDoor: openGroup,
    hold:
      now.mode === 'failed' ? (
        retry
      ) : (
        <div className="board-empty arrive">
          <span className="board-ghost" aria-hidden="true" />
          {ghostLine}
          {ghostCall}
        </div>
      ),
  };

  return (
    <div className="board-screen" style={SCREEN_TILES}>
      {/* THE BOARD KEEPS THE PUZZLE'S TITLE and takes no title of its own (user-decided
          2026-08-30): a board is a view OF a daily, and the lit crown says what the screen
          is. The way OUT is any other key of the same, unmoving row. */}
      <HeaderLeft>
        <PuzzleTitle lang={lang} surface="board" />
      </HeaderLeft>

      {/* WHICH BOARD: the tab row — the result's own. A tap on the shown group goes into it;
          the pinned plus creates. Held at its height while the list of groups is unknown. */}
      <BoardTabs
        tabs={scopes}
        shown={activeIndex}
        onTurn={showScope}
        onOpen={(index) => {
          if (index === activeIndex) openGroup();
        }}
        // With no group the body's CREATE GROUP is the one way to make one.
        onNew={onNone ? undefined : () => setScreen('create')}
        newLabel={t(lang, 'groupNew')}
      />

      {/* THE LINE UNDER THE TABS, one height whatever it holds: a group's three boards,
          GLOBAL's caption, or nothing. */}
      <div className="board-head">
        {tab === 'group' && active ? (
          <PeriodSwitch lang={lang} period={period} onChange={setPeriod} />
        ) : tab === 'global' ? (
          <span className="board-caption">{t(lang, 'scopeGlobalSub')}</span>
        ) : null}
      </div>

      <div
        ref={bodyRef}
        className="board-body"
        {...swipe}
        onClickCapture={(e) => {
          // A swipe's trailing click (a mouse's) lands on nothing.
          if (swiped()) e.stopPropagation();
        }}
      >
        {/* The board shown: the tab row's panel, a stop for the keyboard (it scrolls). */}
        <div
          ref={columnRef}
          className="board-column pixel-scroll"
          role="tabpanel"
          tabIndex={0}
          aria-label={scopes[activeIndex]?.label}
          aria-busy={pending || undefined}
          style={slots > 0 ? { maxHeight: `${slots * LINE_PX}px` } : undefined}
        >
          {/* THE PODIUM, in every state the body can be in: a failed read stands its RETRY in
              the podium's own box; the ghost's caption is the empty board's terse line and its
              one call. */}
          {size && (
            <Podium
              stage={staged}
              tl={tl}
              size={size}
              ghost={{ line: ghostLine, call: ghostCall }}
              failed={retry}
            />
          )}
          <div className="board-under">
            {under.out && <Under view={under.out} out run={under.outRun} {...underProps} />}
            <Under key={view.key} view={view} run={run} {...underProps} />
          </div>
        </div>
      </div>

      {screen === 'group' && active && (
        <GroupScreen
          lang={lang}
          group={active}
          meId={meId}
          busy={busy !== null}
          copied={copied}
          onInvite={() => void invite()}
          onRemove={(member) => setConfirming({ kind: 'remove', member })}
          onLeave={() => {
            setSuccessor(null);
            setConfirming({ kind: 'leave' });
          }}
          onClose={() => setScreen(null)}
        />
      )}
      {screen === 'create' && (
        <GroupCreate lang={lang} busy={busy === 'create'} onCreate={create} onClose={() => setScreen(null)} />
      )}

      {/* REMOVE: the member's face over the act. */}
      {confirming?.kind === 'remove' && active && (
        <ConfirmScreen
          lang={lang}
          title={t(lang, 'groupRemoveTitle')}
          note={t(lang, 'groupRemoveNote')}
          action={t(lang, 'groupRemoveAction')}
          busy={busy === 'remove'}
          onConfirm={() => void remove(confirming.member.publicId)}
          onClose={() => setConfirming(null)}
        >
          <Face player={confirming.member} />
        </ConfirmScreen>
      )}

      {/* LEAVE: the group's name over the act, the note by what the succession does —
          and, for an owner of three or more, the picker: who takes it over. */}
      {confirming?.kind === 'leave' && active && (
        <ConfirmScreen
          lang={lang}
          title={t(lang, 'groupLeaveTitle')}
          note={t(
            lang,
            leaveKind === 'last'
              ? 'groupLeaveLastNote'
              : leaveKind === 'handover'
                ? 'groupLeaveHandoverNote'
                : leaveKind === 'pick'
                  ? 'groupLeaveSuccessorNote'
                  : 'groupLeaveNote',
          )}
          action={t(lang, 'groupLeaveAction')}
          busy={busy === 'leave'}
          disabled={leaveKind === 'pick' && successor === null}
          onConfirm={() => void leave()}
          onClose={() => setConfirming(null)}
        >
          <span className="confirm-group">{active.name}</span>
          {leaveKind === 'pick' && (
            // WHO TAKES IT OVER: the members as the board's lines, the one picked FRAMED —
            // the brackets, the house's selection gesture.
            <div className="board-list confirm-pick" role="radiogroup" aria-label={t(lang, 'groupMembers')}>
              {others.map((id) => {
                const face = faces[id];
                const picked = successor === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={picked}
                    className={`board-row member${picked ? ' picked' : ''}`}
                    onClick={() => setSuccessor(id)}
                  >
                    <Avatar avatar={face?.avatar ?? defaultAvatar(id)} size={MARK} sharp />
                    <span className={`board-name${face?.name ? '' : ' anon'}`}>{face?.name || anonName(id)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </ConfirmScreen>
      )}

      {failure !== null && (
        <ErrorScreen
          lang={lang}
          title={t(
            lang,
            failure === 'account'
              ? 'failedAccount'
              : failure === 'share'
                ? 'failedShare'
                : failure === 'limit'
                  ? 'groupLimit'
                  : 'failedGroup',
          )}
          note={t(
            lang,
            failure === 'account'
              ? 'failedAccountNote'
              : failure === 'share'
                ? 'failedShareNote'
                : failure === 'limit'
                  ? 'groupLimitNote'
                  : 'failedGroupNote',
          )}
          onClose={() => setFailure(null)}
        />
      )}
    </div>
  );
}

// THE PACE of a board: when it begins, how far apart its lines follow, and how long each
// number's reels run. The ARRIVAL leaves the head its beats first (the chip drawn across, the
// brackets locking on) and lands slower; a TURN comes straight in. The lines themselves start
// on the podium's own beat (`Beats.lines`).
interface Pace {
  startMs: number;
  staggerMs: number;
  runMs: number;
}
const ARRIVE: Pace = { startMs: 260, staggerMs: 55, runMs: 650 };
const TURN: Pace = { startMs: 0, staggerMs: 30, runMs: 420 };
// Past the FOLD (the column's last whole slot on screen, and never past PACE_CAP) the lines
// come in together with the last one shown — and so does your line held at the column's edge,
// which covers exactly that slot: the two dissolve in through the same cells at the same
// instant, so the one under it never shows through.
const PACE_CAP = 14;
const SCREEN_TILES = { ...DISSOLVES, ...EDGES } as CSSProperties;
// How a list's lines come in: the pace (from the podium's beat) and the fold.
interface ListRun {
  pace: Pace;
  fold: number;
}
const lineRun = ({ pace, fold }: ListRun, i: number): LineRun => ({
  delayMs: pace.startMs + Math.min(i, fold) * pace.staggerMs,
  runMs: pace.runMs,
});
const listStyle = (rankDigits: number) => ({ '--rank-w': `${rankDigits * 16}px` }) as CSSProperties;
// A slot's dissolve, in or out (CSS `board-dissolve`).
const DISSOLVE_MS = 240;
// How long a turn keeps the board before on screen while the new one's read is out.
const HOLD_MS = 400;
// The skeleton's lines come in only if the read is slow (CSS `.board-skeleton-line`): this
// long, this far apart, then a dissolve.
const SKELETON_WAIT_MS = 320;
const SKELETON_STAGGER_MS = 50;
const SKELETON_LINES = [62, 48, 70, 54, 40];

// The page's animation clock (the dissolves' own): what time it is, and `fn` once `ms` of it
// has passed (an empty animation on `el`) — the wall clock where there is none. Returns the
// cancel.
function clockNow(): number {
  const time = document.timeline?.currentTime;
  return typeof time === 'number' ? time : performance.now();
}
function onClock(el: HTMLElement | null, ms: number, fn: () => void): () => void {
  if (!el || typeof el.animate !== 'function') {
    const timer = window.setTimeout(fn, ms);
    return () => window.clearTimeout(timer);
  }
  const timer = el.animate([], { duration: ms });
  timer.finished.then(fn, () => {});
  return () => timer.cancel();
}

// The board on screen: which board, read for which tab (and which group), and the pace it came
// in at.
interface Shown {
  key: string;
  board: AnyBoard;
  tab: BoardTab;
  group: string | null;
  pace: Pace;
}

// WHAT STANDS UNDER THE PODIUM, as one view: its identity (a new one gives way to the one
// before), the header slot (`sub`: a group's, holding its DOOR — the group's size — and the
// UNIT when nothing above says what the numbers count), and its body: the lines of the board
// shown, the skeleton, the empty board's own block (with no podium to hold it), or nothing.
// `shownFor`: how long it had been on screen when it began to give way.
interface UnderView {
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
function Under({
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
  const list = { lang, meId, run, offset, out, podium: places !== null, places: out ? null : places };
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
        isPeriodBoard(shown.board) ? (
          <PeriodList board={shown.board} {...list} />
        ) : (
          <BoardList
            board={shown.board}
            // Only the GLOBAL list marks the reader's people: on a group's board every row is
            // one, and marking everything marks nothing.
            mates={shown.tab === 'global' ? mates : null}
            {...list}
          />
        )
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

// Which line of a board is yours, and where (its section and rank): the held-edge watch starts
// again whenever it changes — a re-read bringing your line, your row turning from playing to
// ranked.
function ownLineKey(shown: Shown | null, meId: string | null): string {
  if (!shown || !meId) return '';
  const board = shown.board;
  if (isPeriodBoard(board)) return `p${board.rows.find((row) => row.publicId === meId)?.rank ?? ''}`;
  const ranked = [...board.rows, ...(board.own ?? [])].find((row) => row.publicId === meId);
  if (ranked) return `r${ranked.rank}`;
  return board.playing.some((row) => row.publicId === meId) ? 'playing' : '';
}

// Whether a board draws its podium and LINES rather than its empty state (the podium's ghost).
// Empty is per TAB. The GLOBAL board is empty when nobody played. A GROUP's
// board is empty when the caller is ALONE in it: the server includes the caller's own row
// once they played, and a board of exactly yourself still means "nobody else yet", which is
// what the ghost says and INVITE remedies (a member who merely has not played is a waiting
// row, never empty). A period is empty when nobody in the group recorded a score in it.
function hasLines(board: AnyBoard, tab: BoardTab, meId: string | null): boolean {
  if (isPeriodBoard(board)) return board.rows.length > 0;
  const others = board.rows.filter((row) => row.publicId !== meId);
  const playingOthers = board.playing.filter((row) => row.publicId !== meId);
  return !(
    (tab === 'group' ? others.length === 0 && playingOthers.length === 0 : board.rows.length === 0) &&
    (board.own?.length ?? 0) === 0 &&
    board.waiting.length === 0
  );
}

// YOUR LINE STAYS IN SIGHT (CSS: sticky at both edges of the column): this says WHEN it is
// held at an edge rather than standing in its place — `data-stuck` on it, `top` or `bottom` —
// so the lines passing under it thin out through a dithered edge there instead of being cut.
// Its place is read off the line before it (or its list's top); `data-` because the line's
// class is React's. `watch` names what the column shows: a new board, a refresh bringing your
// line or moving it starts the watch again.
function useStuckOwnLine(column: { current: HTMLDivElement | null }, watch: string) {
  useEffect(() => {
    const scroller = column.current;
    const me = scroller?.querySelector<HTMLElement>('.board-under-in .board-row.me');
    if (!scroller || !me) return undefined;
    const read = () => {
      const before = me.previousElementSibling as HTMLElement | null;
      const edge = before ? before.getBoundingClientRect().bottom : (me.parentElement?.getBoundingClientRect().top ?? 0);
      const top = edge - scroller.getBoundingClientRect().top;
      const stuck = top < -0.5 ? 'top' : top + me.offsetHeight > scroller.clientHeight + 0.5 ? 'bottom' : null;
      if (stuck) me.dataset.stuck = stuck;
      else delete me.dataset.stuck;
    };
    read();
    scroller.addEventListener('scroll', read, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    ro?.observe(scroller);
    return () => {
      scroller.removeEventListener('scroll', read);
      ro?.disconnect();
    };
  }, [column, watch]);
}

// WHAT THE PODIUM SHOWS for the body's state: a failure, no group at all, a read still out, an
// empty board (the ghost) — or the board's first three rows on their places (`game/podium.ts`:
// never re-ranked), each with the unit its value counts in (and a period's tiebreakers). Its
// `build` names the picture: a board whose podium changes is a new scene, one shown before is
// the same.
function podiumShows({
  failed,
  none,
  shown,
  meId,
  mates,
  lang,
}: {
  failed: boolean;
  none: boolean;
  shown: Shown | null;
  meId: string | null;
  mates: ReadonlySet<string>;
  lang: LangCode;
}): { build: string; mode: PodiumMode; places: readonly (PodiumEntry | null)[]; period: boolean; seedKey: string } {
  const still = (build: string, mode: PodiumMode) => ({ build, mode, places: NO_PLACES, period: false, seedKey: '' });
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
          detail: 'solvedDays' in place.row ? periodDetail(place.row, lang) : [],
          near: place.near,
          me: place.row.publicId === meId,
          // Only GLOBAL marks the reader's people (on a group's board every row is one).
          mate: shown.tab === 'global' && place.row.publicId !== meId && mates.has(place.row.publicId),
        }
      : null,
  );
  const id = places.map((p) =>
    p ? `${p.player.publicId}:${p.rank}=${p.value}${p.detail.join('/')}${p.me ? '*' : ''}${p.mate ? '+' : ''}` : '-',
  );
  return { build: `${shown.key}|${id.join(',')}`, mode: 'board', places, period, seedKey: shown.key };
}

// A period row's TIEBREAKERS, the lines' own words: the days that recorded a score, and the
// total of their tries.
function periodDetail(row: PeriodRow, lang: LangCode): string[] {
  return [
    `${row.solvedDays} ${t(lang, row.solvedDays === 1 ? 'dayUnit' : 'daysUnit')}`,
    `${row.total} ${t(lang, 'tries').toLowerCase()}`,
  ];
}

// Whether a board's lines carry numbers.
function listCounts(board: AnyBoard): boolean {
  if (isPeriodBoard(board)) return board.rows.length > 0;
  return board.rows.length > 0 || (board.own?.length ?? 0) > 0 || board.playing.length > 0;
}

// A section's caption on the column (IN PROGRESS, NOT PLAYED YET): the words, then the
// stippled rail running on — said once for every line under it.
function Section({ text, slot, run: list }: { text: string; slot: number; run: ListRun }) {
  const run = lineRun(list, slot);
  return (
    <li className="board-section" style={{ '--delay': `${run.delayMs}ms` } as CSSProperties}>
      <span>{text}</span>
    </li>
  );
}

// WHILE THE FIRST READ IS OUT: the board's lines as stippled rails where the marks and the
// names will stand — the box of what is coming, at its pitch, so nothing moves when it lands.
// Giving way (`out`), only the lines that had come in by then are there to go.
function Skeleton({
  lang,
  run,
  offset,
  out,
  shownFor,
}: {
  lang: string;
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
              '--i': i,
              ...(out ? { '--delay': `${lineRun(run, offset + i).delayMs}ms` } : {}),
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
// is a picture): rank, name, value, unit — and a period's tiebreakers.
function PodiumItems({ places }: { places: readonly (PodiumEntry | null)[] | null }) {
  if (!places) return null;
  return (
    <>
      {places.map((place) =>
        place ? (
          <li key={place.player.publicId} className="sr-only" aria-current={place.me || undefined}>
            #{place.rank} {place.player.name || anonName(place.player.publicId)} {place.value} {place.unit.toLowerCase()}
            {place.detail.length > 0 && ` · ${place.detail.join(' · ')}`}
          </li>
        ) : null,
      )}
    </>
  );
}

interface ListProps {
  lang: LangCode;
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

// A DAY's lines past the podium's three (or all of them, with no podium): the ranked rows, the
// caller's own window under the rail of the rows left out (GLOBAL, below the cut), then IN
// PROGRESS and NOT PLAYED YET, each under its caption. (An empty board is the podium's ghost:
// no list.)
function BoardList(props: ListProps & { board: Board; mates: ReadonlySet<string> | null }) {
  const { board, lang, meId, mates, offset, podium, places } = props;
  const run = useListRun(props);
  // The ranked rows past the podium's three, then the caller's own window.
  const ranked = podium ? dayPodium(board.rows).lines : board.rows;
  // ONE rank column for the whole list, as wide as its widest rank (two digits at the least).
  const rankDigits = Math.max(2, ...[...ranked, ...(board.own ?? [])].map((row) => String(row.rank).length));
  // (Every item takes a slot, the rail too: the slot it stands in times it.)
  let slot = offset;
  const item = (row: BoardRow) => {
    const i = slot++;
    return (
      <BoardRowItem
        key={row.publicId}
        row={row}
        me={row.publicId === meId}
        mate={mates?.has(row.publicId) ?? false}
        index={i}
        run={lineRun(run, i)}
      />
    );
  };
  const gap = () => {
    const i = slot++;
    return <li className="board-gap" aria-hidden="true" style={{ '--delay': `${lineRun(run, i).delayMs}ms` } as CSSProperties} />;
  };
  return (
    <ol className="board-list" style={listStyle(rankDigits)}>
      <PodiumItems places={places} />
      {ranked.map(item)}
      {board.own && board.own.length > 0 && (
        <>
          {gap()}
          {board.own.map(item)}
        </>
      )}
      {board.playing.length > 0 && <Section text={t(lang, 'boardPlaying')} slot={slot++} run={run} />}
      {board.playing.map((row) => {
        const i = slot++;
        return <PlayingRowItem key={row.publicId} row={row} me={row.publicId === meId} index={i} run={lineRun(run, i)} />;
      })}
      {board.waiting.length > 0 && <Section text={t(lang, 'boardNotPlayed')} slot={slot++} run={run} />}
      {board.waiting.map((player) => {
        const i = slot++;
        return <WaitingRowItem key={player.publicId} player={player} index={i} run={lineRun(run, i)} />;
      })}
    </ol>
  );
}

// A WEEK or a MONTH (#271), past the podium's three (or all of them): the shared period rule's
// three numbers per member — podium POINTS as the line's number, then the days and the total as
// a quiet detail under the name.
function PeriodList(props: ListProps & { board: PeriodBoard }) {
  const { board, lang, meId, offset, podium, places } = props;
  const run = useListRun(props);
  const ranked = podium ? periodPodium(board.rows).lines : board.rows;
  const rankDigits = Math.max(2, ...ranked.map((row) => String(row.rank).length));
  return (
    <ol className="board-list" style={listStyle(rankDigits)}>
      <PodiumItems places={places} />
      {ranked.map((row, index) => (
        <PeriodRowItem
          key={row.publicId}
          row={row}
          me={row.publicId === meId}
          index={offset + index}
          lang={lang}
          run={lineRun(run, offset + index)}
        />
      ))}
    </ol>
  );
}

function PeriodRowItem({
  row,
  me,
  index,
  lang,
  run,
}: {
  row: PeriodRow;
  me: boolean;
  index: number;
  lang: LangCode;
  run: LineRun;
}) {
  return (
    <li
      className={`board-row period${me ? ' me' : ''}`}
      style={{ '--i': index, '--delay': `${run.delayMs}ms`, '--land': `${run.delayMs + run.runMs}ms` } as CSSProperties}
      aria-current={me || undefined}
    >
      <BoardRank rank={row.rank} />
      <Avatar avatar={row.avatar ?? defaultAvatar(row.publicId)} size={MARK} sharp />
      <span className="board-ident">
        <span className={`board-name${row.name ? '' : ' anon'}`}>{row.name || anonName(row.publicId)}</span>
        {/* The tiebreakers, said small under the name: the days that recorded a score,
            and the total of their tries. */}
        <span className="board-detail">
          {row.solvedDays} {t(lang, row.solvedDays === 1 ? 'dayUnit' : 'daysUnit')} · {row.total}{' '}
          {t(lang, 'tries').toLowerCase()}
        </span>
      </span>
      <span className="board-score">
        <ReelNumber value={row.points} delayMs={run.delayMs} runMs={run.runMs} />
      </span>
    </li>
  );
}

// WHO is at stake, over a confirmation: the mark and the name, the crossroads' own stack.
function Face({ player }: { player: BoardPlayer }) {
  return (
    <span className="confirm-face">
      <Avatar avatar={player.avatar ?? defaultAvatar(player.publicId)} size={60} sharp />
      <span className={`confirm-name${player.name ? '' : ' anon'}`}>{player.name || anonName(player.publicId)}</span>
    </span>
  );
}
