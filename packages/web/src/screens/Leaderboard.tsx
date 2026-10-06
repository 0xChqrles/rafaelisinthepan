import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { anonName, dateForDayNumber, defaultAvatar, type BoardPeriod, type BoardPlayer, type GroupSummary } from '@whippin/shared';
import { readGroup, type GroupsBody } from '../api';
import { clockNow, onClock } from '../components/animationClock';
import Avatar from '../components/Avatar';
import { DISSOLVE_MS, cameIn } from '../components/bayerTiles';
import BoardTabs, { tabIds, type BoardTabItem } from '../components/BoardTabs';
import Under, {
  ARRIVE,
  PACE_CAP,
  TURN,
  lineRun,
  type Gone,
  type ListRun,
  type Shown,
  type UnderView,
} from '../components/BoardUnder';
import ConfirmScreen from '../components/ConfirmScreen';
import { LINE_PX, MARK } from '../components/boardMetrics';
import GroupCreate from '../components/GroupCreate';
import GroupScreen from '../components/GroupScreen';
import LoadError from '../components/LoadError';
import PeriodSwitch from '../components/PeriodSwitch';
import Podium, { nextStage, type PodiumStage } from '../components/podium/Podium';
import { beats, podiumHeightPx, podiumSize, type PodiumSize } from '../components/podium/scene';
import PuzzleTitle from '../components/PuzzleTitle';
import { HeaderLeft } from '../components/TopBar';
import useMoreBelow from '../hooks/useMoreBelow';
import useShare from '../hooks/useShare';
import useStuckOwnLine from '../hooks/useStuckOwnLine';
import useSwipe from '../hooks/useSwipe';
import useToday from '../hooks/useToday';
import { prefersReducedMotion } from '../hooks/useScramble';
import { identityEpoch, identityEpochOf, useDeviceIdentity } from '../identity';
import { boardTargetKey, openingGroup, readBoard, takeOpening, type BoardTarget } from '../state/boardOpening';
import { createGroup, failureOf, groupFailureCopy, inviteText, writeGroups, type GroupFailure, type GroupWrite } from '../state/groupActs';
import { loadGroups, useGroups } from '../state/groups';
import { prefetchTurnstileTokens } from '../turnstile';
import ErrorScreen from '../components/ErrorScreen';
import { useGameStore, type BoardTab } from '../state/gameStore';
import type { LangCode } from '../langs';
import { isPeriodBoard, listCounts, ownLineKey, podiumShows, type AnyBoard } from '../game/boardView';
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
// time a board is shown in the day (in this tab) the podium BUILDS (its steps rising, its
// players dropping onto them, the values landing on the result count's reels and first place's
// cobalt dissolving into the foil — the result's own gesture) and its lines follow it in, one
// after another through the Bayer dissolve (CSS `board-dissolve`), their numbers on the same
// reels (`ReelNumber`); a board shown again — turned back to, or on a later visit — is SETTLED,
// its lines simply dissolving in. The first board on screen ARRIVES (after the head's own
// beats); every board turned to after it comes in quicker, and GIVES WAY to the one before
// slot by slot — the one before keeping every slot until the new one's line dissolves in
// through it — so no frame of a turn is a bare list; a read that keeps it waiting long lets it
// give way to the loading picture instead (a podium crowning another tab's winner says
// something false). Every box is laid out from its first frame — the podium's the same height
// in every state, its size chosen off the room the screen has (none at all where it would
// leave the lines none: they start at the first, crowned, in the result's dress) — so nothing
// that has landed moves; reduced motion draws the board landed.
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
//
// The screen keeps the state, the reads and the acts (the board's read itself is
// `state/boardOpening.ts`); what stands under the podium is `BoardUnder`, the board's
// readings `game/boardView.ts`, its list's order `game/boardSlots.ts`.

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

// How long a turn keeps the board before on screen while the new one's read is out.
const HOLD_MS = 400;

// A view under the podium GIVING WAY: what it was and how it had been shown, whether its header
// slot stands for the one after it, and the run of the one it gives way to, from when it began.
interface Leaving {
  view: UnderView;
  gone: Gone;
  still: boolean;
  run: ListRun;
  since: number;
}

// WHAT THE PODIUM HAS BUILT today in this tab (its scenes' identities, each with its language),
// for the identity it was built under: a board shown again — turned back to, or on the next
// visit to the screen, in either language — is that board, settled; its build is never replayed
// (that would be a wait every time the crown is tapped, and would move what had landed). A new
// day or a new identity starts it again, as it drops the screen's caches.
const built = { scope: '', builds: new Set<string>() };
function builtFor(scope: string): Set<string> {
  if (built.scope !== scope) {
    built.scope = scope;
    built.builds = new Set();
  }
  return built.builds;
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

  // The player's groups — the tabs. Read off the ONE cache every group surface shares;
  // tokenless it is known-empty without a request.
  const { phase: groupsPhase, groups } = useGroups();
  useEffect(() => {
    loadGroups();
  }, [identity]);
  const active: GroupSummary | null = openingGroup(groups, lastGroupId);
  // The reader's own people, for marking rows among the global ones: the union of every
  // group they are in, which the list already carries.
  const mates = new Set(groups?.flatMap((group) => group.members) ?? []);

  // THE TABS, in the row's order: every group — or, with none, the one tab that SAYS so (a
  // state, not a name: `bare`, no chip; its body carries CREATE GROUP) — then GLOBAL, pinned
  // at the row's end (every player has it, however long the groups' names run).
  const tabs: BoardTabItem[] =
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
    tabs.length === 0
      ? 0
      : tab === 'global'
        ? tabs.length - 1
        : active === null
          ? 0
          : Math.max(0, tabs.findIndex((item) => item.key === active.id));
  const turnTo = (index: number) => {
    const item = tabs[index];
    if (!item) return;
    if (item.key === 'global') {
      setTab('global');
    } else {
      if (item.key !== 'none') setLastGroup(item.key);
      setTab('group');
    }
  };

  // ONE outcome slot per board — a board, or that board's own failure — keyed by what it
  // shows. Screen-global failure state would paint a FAILED frame over another board's
  // perfectly good rows for a render when flipping back.
  const boardTarget: BoardTarget | null =
    tab === 'global' ? { tab: 'global' } : active ? { tab: 'group', group: active.id, period } : null;
  const boardKey = boardTarget === null ? null : boardTargetKey(boardTarget);
  const [boards, setBoards] = useState<Partial<Record<string, AnyBoard | 'failed'>>>({});
  const [attempt, setAttempt] = useState(0);
  // THE BOARD ON SCREEN — the last one resolved, HELD while the next one's first read is out,
  // so a turn to a board not read yet keeps its lines (and the door over them) until the new
  // lines dissolve in over them: a read lands as one board giving way to the next, never as a
  // blank column. HELD FOR HOLD_MS AT MOST: a read that outlasts it (`lapsed`, the key it was
  // for) lets the board before give way to the loading picture — a held board under another
  // tab's name says something false, and a podium says it loudly. Same cache scope as `boards`
  // (dropped with it below). The hold's clock starts again on every turn to a board: a board
  // whose read lapsed once is held again the next time it is turned to — but only a board ON
  // SCREEN is held: a turn made from the loading picture or a failure starts lapsed (the board
  // before them is long gone, and bringing it back would say it under this tab's name).
  // A board whose last read FAILED is asked again from scratch on that turn — its failure
  // dropped in the same render, so re-entering it shows neither its RETRY nor a frame of the
  // failed view giving way.
  const [held, setHeld] = useState<Shown | null>(null);
  const [lapsed, setLapsed] = useState<string | null>(null);
  const [lapseKey, setLapseKey] = useState(boardKey);
  const shownKey = useRef<string | null>(null);
  const cached = boardKey === null ? undefined : boards[boardKey];
  const reentered = lapseKey !== boardKey && cached === 'failed';
  if (lapseKey !== boardKey) {
    setLapseKey(boardKey);
    setLapsed(held !== null && shownKey.current !== held.key ? boardKey : null);
    if (reentered && boardKey !== null) setBoards((prev) => ({ ...prev, [boardKey]: undefined }));
  }

  // THE DAY IS A LIVE VALUE: a board is left open across the 22:00-ET flip routinely, and a
  // new day is a new board, so every cache goes with it — dropped during render so
  // yesterday's rows are never committed under today's date.
  const date = dateForDayNumber(useToday());
  const played = builtFor(`${date}|${epoch ?? ''}`);
  const [cachedDate, setCachedDate] = useState(date);
  // (This render still reads the dropped caches: nothing is taken from them below.)
  let dropped = false;
  if (cachedDate !== date) {
    setCachedDate(date);
    setBoards({});
    setHeld(null);
    setLapsed(null);
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
    dropped = true;
  }

  // One fetch per board ACTIVATION — the route is a zero-TTL live read, so a turn re-reads
  // rather than trusting a snapshot; the cached board holds the screen while the fresh one
  // is in flight (stale-but-good beats a spinner), and RETRY refetches. The read is
  // `readBoard` (state/boardOpening.ts); the screen's OPENING takes the one the tap that opened
  // it already started, for exactly this board, instead of asking again.
  useEffect(() => {
    if (boardTarget === null || boardKey === null) return;
    const key = boardKey;
    const target = boardTarget;
    let cancelled = false;
    // No token, no private fetch (#216): a group's board cannot exist tokenless (the list is
    // empty), so only the global read runs without an identity.
    if (target.tab === 'group' && !identity) return;
    const epochNow = identity ? identityEpochOf(identity) : null;
    // The screen's FIRST activation only (a remove's re-read, a retry: afresh).
    const opened = attempt === 0 ? takeOpening(lang, date, key, epochNow) : null;
    let answered = false;
    (async () => {
      try {
        const board = await (opened?.answer ?? readBoard(lang, date, target, identity));
        answered = true;
        if (!cancelled && (epochNow === null || identityEpoch() === epochNow)) {
          setBoards((prev) => ({ ...prev, [key]: board }));
        }
      } catch {
        answered = true;
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
      // An activation ended before its opening answered hands it back (React's development
      // re-run of this effect; the screen left at once): the next opening of this board takes it.
      if (!answered) opened?.release();
    };
    // `active?.id` rather than `active`: the list object is re-read, the group is not.
  }, [boardKey, tab, active?.id, period, lang, date, attempt, identity]);

  const entry = reentered ? undefined : cached;
  const board = entry === 'failed' ? undefined : entry;

  // ---- the deliberate acts: CREATE, INVITE, LEAVE, REMOVE — on the group's own screens,
  // never on the board. Each is `state/groupActs.ts`' (the result's seat shares them): the
  // write answers the list as it now stands, published through `adoptGroups`, and a failure
  // lands on the app's error surface, since saying nothing leaves the player tapping a
  // button that appears to do nothing.
  const [busy, setBusy] = useState<'create' | 'invite' | 'leave' | 'remove' | null>(null);
  const [failure, setFailure] = useState<GroupFailure | null>(null);
  // WHICH SCREEN is up over the board, and WHICH CONFIRMATION over that.
  const [screen, setScreen] = useState<'group' | 'create' | null>(null);
  const [confirming, setConfirming] = useState<{ kind: 'remove'; member: BoardPlayer } | { kind: 'leave' } | null>(null);
  const [successor, setSuccessor] = useState<string | null>(null);
  // Whether the picker holds more members below what it shows (its foot's dithered edge).
  const [pickRef, pickMore] = useMoreBelow<HTMLDivElement>();
  // The members DRESSED (name + mark) for the successor picker: the list carries ids
  // alone, and `GET /groups?id=` is the public face that names them. Decoration — until
  // it lands, and if it never does, the rows wear the assigned identities.
  const [faces, setFaces] = useState<Record<string, BoardPlayer>>({});
  const { share, copied } = useShare({ tracked: false });
  useEffect(() => {
    if (identity === null) prefetchTurnstileTokens(1);
  }, [identity]);

  // ONE gesture for every write (`writeGroups`): the deploy (a tokenless tap mints the account
  // first, the button holding its loading state for both legs), then the signed POST, then
  // the list — and what did not land, on the error surface (`failureOf`: a stale succession
  // is no failure, the leave asks again below).
  const perform = async (kind: NonNullable<typeof busy>, act: () => Promise<GroupWrite>): Promise<GroupWrite> => {
    setBusy(kind);
    setFailure(null);
    const result = await act();
    setFailure(failureOf(result));
    setBusy(null);
    return result;
  };
  const write = (kind: NonNullable<typeof busy>, body: (token: string) => GroupsBody) =>
    perform(kind, () => writeGroups(epoch, body));

  // The create screen closes ITSELF once the group exists (it plays the name inked in
  // first); the board is already on the new group when it does. Refused or failed, it stays
  // up under the error surface, the name kept.
  const create = async (name: string): Promise<boolean> => {
    if (busy) return false;
    const result = await perform('create', () => createGroup(epoch, name));
    if (result.kind === 'done' && result.created) {
      setLastGroup(result.created);
      setTab('group');
      setPeriod('day');
      return true;
    }
    return false;
  };

  // Delivery (native sheet -> clipboard + COPIED) is useShare's, like every result.
  const invite = async () => {
    if (busy || !active) return;
    setFailure(null);
    const delivered = await share(inviteText(lang, window.location.origin, active.id));
    if (!delivered) setFailure('share');
  };

  // The succession the LEAVE carries: who else is in the group decides whether the owner
  // names somebody. A list gone stale by the time the tap lands is the server's 409
  // `successor_required`: the confirmation stays up, its pick cleared, and the list is read
  // again — the picker then asks among the members as they now stand.
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
    // Deliberately `active?.id`, not `active`: the list object is re-read, the group is not —
    // but a re-read that changes who is in it dresses the newcomers.
  }, [confirming?.kind, leaveKind, active?.id, active?.members.join(',')]);

  const leave = async () => {
    if (busy || !active) return;
    if (leaveKind === 'pick' && successor === null) return;
    const id = active.id;
    const result = await write('leave', (token) => leaveBody(token, id, leaveKind, successor));
    setSuccessor(null);
    if (result.kind === 'refused' && result.error === 'successor_required') {
      loadGroups();
      return;
    }
    setConfirming(null);
    if (result.kind === 'done') setScreen(null);
  };

  const remove = async (member: string) => {
    if (busy || !active) return;
    const result = await write('remove', (token) => ({ token, remove: active.id, member }));
    setConfirming(null);
    if (result.kind === 'done') setAttempt((n) => n + 1);
  };

  // INTO the group shown: its own screen (the list refreshed on the way in).
  const openGroup = () => {
    if (tab !== 'group' || active === null) return;
    loadGroups();
    setScreen('group');
  };
  // A sideways swipe on the lines turns the tab row; its click opens nothing.
  const { handlers: swipe, swiped } = useSwipe((step) => turnTo(activeIndex + step));

  const bodyRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const tabsId = useId();

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

  // THE ROOM, measured: the first screen's height under the held head in whole lines (the
  // window's, less the shell's foot) and the body's width — the podium's size follows it
  // (`podiumSize`: roomy, compact, or none at all where it would leave the lines no room), with
  // a line's grace for the size it has, so a phone's toolbar never flips it. The head's height
  // is published too (`--board-top`): where your own line holds under it.
  const [room, setRoom] = useState<{ slots: number; width: number } | null>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const top = topRef.current;
    if (!body || !top) return undefined;
    const measure = () => {
      const head = top.getBoundingClientRect().bottom;
      screenRef.current?.style.setProperty('--board-top', `${Math.round(head)}px`);
      const foot = parseFloat(getComputedStyle(body.closest('.app') ?? body).paddingBottom) || 0;
      const next = { slots: Math.floor((window.innerHeight - head - foot) / LINE_PX), width: body.clientWidth };
      setRoom((was) => (was && was.slots === next.slots && was.width === next.width ? was : next));
    };
    measure();
    window.addEventListener('resize', measure);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(body);
    ro?.observe(top);
    return () => {
      window.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, []);
  const [size, setSize] = useState<PodiumSize | null>(null);
  const sizeNow = room ? podiumSize(room.width, room.slots, size) : size;
  if (sizeNow !== size) setSize(sizeNow);

  // WHEN THE HEAD'S BEATS BEGAN: the commit that first shows the tab row's chip (wiped across
  // it, a group's period brackets locking on — CSS, timed from their elements' showing). A bare
  // tab shows no chip, and a row drawn again from nothing plays them again.
  const headAt = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (tabs.length === 0 || tabs[activeIndex]?.bare) headAt.current = null;
    else if (headAt.current === null) headAt.current = clockNow();
  });

  // THE PODIUM: what it shows — the board's top three, or the state the body is in, each its
  // own picture in its one box — latched as a STAGE whenever that changes, read off the stage
  // before it (`nextStage`: whether it builds, who stays, which values run again), so the
  // lines under it are timed off the very beats it plays. A board builds the first time it is
  // shown in the day (`builtFor`); the first board ARRIVES, leaving the head its beats. Latched
  // with the SIZE too: a rotation that takes the podium away and brings it back shows the same
  // board again, settled — never its build replayed.
  const now = podiumShows({
    failed: (tab === 'group' && groupsPhase === 'failed' && groups === null) || entry === 'failed',
    none: tab === 'group' && onNone,
    shown,
    meId,
    mates,
    lang,
  });
  // (Each stage also keeps when its picture became its own: at once for the screen's first, else
  // once it has given way from the one before — a new size is a new layout, not a new picture.)
  const [stage, setStage] = useState<(PodiumStage & { size: PodiumSize | null; ownAt: number }) | null>(null);
  let staged = stage;
  const shownPace = shown?.pace ?? ARRIVE;
  if (staged === null || staged.build !== now.build || staged.size !== size) {
    const at = clockNow();
    const fresh = now.mode === 'board' && !played.has(`${lang}|${now.build}`);
    const arriving = shown?.pace === ARRIVE;
    // The ARRIVAL leaves the head its beats, counted from when they began: a board that lands
    // after they have played starts at once — its build, out of a loading picture wholly its
    // own (`outOfLoading`), or with no podium its lines; a settled podium's lines still wait
    // its dissolve. Decided as the stage latches, the one moment it is read.
    const outOfLoading = arriving && fresh && stage?.mode === 'loading' && at >= stage.ownAt;
    const late = arriving && headAt.current !== null && (size === null || outOfLoading);
    const startMs = late ? Math.max(0, ARRIVE.startMs - (at - headAt.current!)) : shownPace.startMs;
    const ownAt = stage === null ? at : stage.build === now.build ? stage.ownAt : at + DISSOLVE_MS;
    staged = { ...nextStage(stage, now, fresh, startMs, shownPace.runMs, outOfLoading), size, ownAt };
    setStage(staged);
  }
  const tl = useMemo(() => beats(staged.spec), [staged]);
  useEffect(() => {
    if (staged.mode === 'board') played.add(`${lang}|${staged.build}`);
  }, [staged, played, lang]);

  // THE PAGE SCROLLS AS ONE under the held head — the podium, the list's header, the lines — so
  // a long board carries the podium away and the reader down to their own line. The first
  // screen's room in WHOLE LINES says where the FOLD is: the slots past it come in with the
  // last one on screen.
  const slots = room?.slots ?? 0;
  const fold = slots > 0 ? Math.max(0, Math.min(PACE_CAP, slots - (size ? podiumHeightPx(size) / LINE_PX : 0) - 1)) : PACE_CAP;
  // How the lines come in: on the podium's own beat (on their own, with no podium), quicker on
  // a turn, their numbers on the reels only where the board is shown for the first time (a
  // board shown again is settled: its lines dissolve in, their numbers standing — and so does
  // every board under reduced motion).
  const run: ListRun = {
    pace: {
      startMs: size ? tl.lines : staged.spec.startMs,
      staggerMs: shownPace.staggerMs,
      runMs: staged.spec.build && !prefersReducedMotion() ? shownPace.runMs : 0,
    },
    fold,
  };
  // A board turned to opens at its top.
  const openedOn = useRef(true);
  useLayoutEffect(() => {
    if (openedOn.current) {
      openedOn.current = false;
      return;
    }
    if (window.scrollY > 0) window.scrollTo(0, 0);
  }, [shown?.key]);

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
  // RETRY asks the failed board again from scratch: its failure dropped, and the loading picture
  // standing for it (never a board held from before the failure).
  const retry =
    now.mode === 'failed' ? (
      <LoadError
        message={t(lang, 'failedBoard')}
        lang={lang}
        onRetry={() => {
          if (entry !== 'failed' || boardKey === null) {
            loadGroups();
            return;
          }
          setBoards((prev) => ({ ...prev, [boardKey]: undefined }));
          setLapsed(boardKey);
          setAttempt((n) => n + 1);
        }}
      />
    ) : null;
  // (With no podium, the empty board's block — or the failed read's RETRY — stands under the
  // header slot as ONE ROW, the ghost beside its line over its call: the room a landscape phone
  // has.)
  const hold =
    now.mode === 'failed' ? (
      retry
    ) : (
      <div className="board-empty">
        <span className="board-ghost" aria-hidden="true" />
        {(ghostLine || ghostCall) && (
          <div className="board-empty-say">
            {ghostLine}
            {ghostCall}
          </div>
        )}
      </div>
    );

  // WHAT STANDS UNDER THE PODIUM (`Under`): a group's header slot — its door, and the unit
  // when nothing above says it — then the lines, the skeleton, or (with no podium) the empty
  // board's own block. A new one GIVES WAY to the one before slot by slot: the one before
  // stays (`outs`) and each of its slots dissolves out through exactly the cells the new one's
  // slot dissolves in through, on the new one's beat — so no frame of a turn is a bare list. A
  // turn caught halfway is turned again from what is on screen: the view still coming in gives
  // way with what of it had come in (`cameIn`), and the one it was replacing goes on going out
  // through the cells it was leaving by. A header slot both views say the same stands.
  const holdKind = now.mode === 'failed' || now.mode === 'ghost' ? now.mode : null;
  const viewTab = shown?.tab ?? tab;
  // The header slot heads a group's list (its door), and — with no podium to say it — what the
  // numbers count; an empty board's block takes it only for a door (no group, a failed or empty
  // GLOBAL: nothing to say there, and on a landscape phone no room to say it in).
  const door = shownGroup ? shownGroup.members.length : null;
  const sub = door !== null || (holdKind === null && (viewTab === 'group' || size === null));
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
    size,
    sub,
    door,
    unit: counts && shown ? (isPeriodBoard(shown.board) ? 'points' : 'tries') : null,
    body: holdKind ? (size ? null : 'hold') : shown ? 'list' : 'skeleton',
    shown: holdKind ? null : shown,
    hold: holdKind && !size ? hold : null,
  };
  // The view on screen — its key, since when, the run it came in on, whether its header slot
  // stands — and the ones before it giving way under it (`Leaving`).
  const lastView = useRef(view);
  const [under, setUnder] = useState<{ key: string; since: number; run: ListRun; still: boolean; outs: Leaving[] }>(
    () => ({ key: view.key, since: clockNow(), run, still: false, outs: [] }),
  );
  if (under.key !== view.key) {
    const was = lastView.current;
    const at = clockNow();
    const gone = { shownFor: at - under.since, inRun: under.run };
    const gives =
      !prefersReducedMotion() &&
      was.key === under.key &&
      was.size === view.size &&
      (was.body !== null || was.door !== null);
    const still =
      gives &&
      was.sub &&
      view.sub &&
      was.door === view.door &&
      was.unit === view.unit &&
      (under.still || cameIn(lineRun(under.run, 0).delayMs, gone.shownFor));
    setUnder({
      key: view.key,
      since: at,
      run,
      still,
      outs: gives ? [...under.outs, { view: was, gone, still, run, since: at }] : [],
    });
  }
  useLayoutEffect(() => {
    lastView.current = view;
    shownKey.current = shown?.key ?? null;
  });
  // A view before is gone once its last slot has dissolved out (on the page's animation clock,
  // as the dissolve itself is).
  useEffect(() => {
    const cancels = under.outs.map((leaving) =>
      onClock(
        columnRef.current,
        Math.max(0, leaving.since + lineRun(leaving.run, leaving.run.fold).delayMs + DISSOLVE_MS - clockNow()),
        () =>
          setUnder((now) =>
            now.outs.includes(leaving) ? { ...now, outs: now.outs.filter((o) => o !== leaving) } : now,
          ),
      ),
    );
    return () => cancels.forEach((cancel) => cancel());
  }, [under.outs]);
  useStuckOwnLine(columnRef, `${view.key}|${now.build}|${ownLineKey(shown, meId)}`);
  const underProps = { lang, meId: meId ?? undefined, mates, places: size ? staged.places : null, onDoor: openGroup };

  return (
    <div ref={screenRef} className="board-screen">
      {/* THE BOARD KEEPS THE PUZZLE'S TITLE and takes no title of its own (user-decided
          2026-08-30): a board is a view OF a daily, and the lit crown says what the screen
          is. The way OUT is any other key of the same, unmoving row. */}
      <HeaderLeft>
        <PuzzleTitle lang={lang} surface="board" />
      </HeaderLeft>

      {/* THE HEAD, held while the page scrolls under it (`.board-top`). */}
      <div ref={topRef} className="board-top">
      {/* WHICH BOARD: the tab row — the result's own. A tap on the shown group goes into it;
          the pinned plus creates. While the list of groups is unknown its room is held by one
          stippled chip (breathing while the list is read, still once a read has failed). */}
      <BoardTabs
        tabs={tabs}
        shown={activeIndex}
        onTurn={turnTo}
        onOpen={(index) => {
          if (index === activeIndex) openGroup();
        }}
        // With no group the body's CREATE GROUP is the one way to make one.
        onNew={onNone ? undefined : () => setScreen('create')}
        newLabel={t(lang, 'groupNew')}
        idBase={tabsId}
        hold={groupsPhase === 'failed' ? 'failed' : 'waiting'}
      />

      {/* THE LINE UNDER THE TABS, one height whatever it holds: a group's three boards,
          GLOBAL's caption, or nothing. */}
      <div className="board-head">
        {tab === 'group' && active ? (
          <PeriodSwitch lang={lang} period={period} onChange={setPeriod} />
        ) : tab === 'global' ? (
          <span className="board-caption">{t(lang, 'boardGlobalSub')}</span>
        ) : null}
      </div>
      </div>

      <div
        ref={bodyRef}
        className="board-body"
        {...swipe}
        onClickCapture={(e) => {
          // A swipe's trailing click lands on nothing.
          if (swiped(e)) e.stopPropagation();
        }}
      >
        {/* The board shown: the tab row's panel. */}
        <div
          ref={columnRef}
          className="board-column"
          role="tabpanel"
          id={tabIds(tabsId).panel}
          tabIndex={0}
          aria-labelledby={tabs[activeIndex] ? tabIds(tabsId).tab(tabs[activeIndex].key) : undefined}
          aria-busy={pending || undefined}
          // While a view gives way the column keeps a screen's room, so a shorter one coming in
          // never cuts the lines going out; it closes up to its content once they are gone (bare
          // ground).
          style={slots > 0 && under.outs.length > 0 ? { minHeight: `${slots * LINE_PX}px` } : undefined}
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
            {under.outs.map((leaving) => (
              <Under
                key={`out:${leaving.since}:${leaving.view.key}`}
                view={leaving.view}
                gone={leaving.gone}
                still={leaving.still}
                run={leaving.run}
                {...underProps}
              />
            ))}
            <Under key={view.key} view={view} still={under.still} run={under.run} {...underProps} />
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
            <div
              ref={pickRef}
              className="board-list confirm-pick"
              data-more={pickMore || undefined}
              role="radiogroup"
              aria-label={t(lang, 'groupMembers')}
            >
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
        <ErrorScreen lang={lang} {...groupFailureCopy(lang, failure)} onClose={() => setFailure(null)} />
      )}
    </div>
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
