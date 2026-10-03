import { useEffect, useRef, useState, type CSSProperties } from 'react';
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
import {
  BoardRank,
  BoardRowItem,
  MARK,
  PlayingRowItem,
  WaitingRowItem,
  type LineRun,
} from '../components/BoardRows';
import { DISSOLVES, EDGES } from '../components/bayerTiles';
import GroupCreate from '../components/GroupCreate';
import GroupScreen from '../components/GroupScreen';
import LoadError from '../components/LoadError';
import PeriodSwitch from '../components/PeriodSwitch';
import PuzzleTitle from '../components/PuzzleTitle';
import ReelNumber from '../components/ReelNumber';
import { HeaderLeft } from '../components/TopBar';
import ChevronIcon from '../assets/icons/chevron-left.svg?react';
import useShare from '../hooks/useShare';
import useSwipe from '../hooks/useSwipe';
import useToday from '../hooks/useToday';
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
// THE BOARD LANDS: its lines come in one after another through the Bayer dissolve (CSS
// `board-dissolve`, the ordered dither stepping each line's mask to full), each number lands on
// the result count's REELS (`ReelNumber`), and on the leader's number landing the crown's
// cobalt dissolves into the FOIL (`FoilCrown`) — the screen's one shiny thing. The first board
// on screen ARRIVES (slower, after the head's own beats); every board turned to after it comes
// in quicker. Every line's box is laid out from its first frame, so nothing that has landed
// moves; reduced motion draws the board landed.
//
// The rows come ranked from the server (competition ties, the plain top-50 cut, the
// own-row window, the period rule — @whippin/shared's leaderboard rules); this screen only
// draws what the API returned. Rows CONNECTED to the reader stay apart: your own line is
// FRAMED by the corner brackets (and stays in sight on a long board, held to the list's edge
// while it is scrolled out of view); among the global rows, a member of one of your groups
// carries a small accent mark at the line's start.
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
  // so a turn to a board not read yet keeps its lines (and the caption over them) until the
  // new lines dissolve in over them: a read lands as one board giving way to the next, never
  // as a blank column. Same cache scope as `boards` (dropped with it below).
  const [held, setHeld] = useState<Shown | null>(null);

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
    setHeld({ key: boardKey, board, tab, pace: held?.key === boardKey ? held.pace : pace });
  }
  // What the body draws: that board — or, while this one's read is out, the one held.
  const shown = entry === 'failed' ? null : held;

  // THE LIST'S HEIGHT IN WHOLE LINES: the body's room, floored to the lines' pitch, so a list
  // that scrolls rests on whole lines (its scroll snaps to them) and your line held at its
  // edge covers exactly one — never half a name. Its count also says where the FOLD is: the
  // lines past it come in with the last one on screen.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [slots, setSlots] = useState(0);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setSlots(Math.floor(body.clientHeight / LINE_PX)));
    ro.observe(body);
    return () => ro.disconnect();
  }, []);
  const fold = slots > 0 ? Math.min(PACE_CAP, slots - 1) : PACE_CAP;

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

      {/* THE LIST'S OWN HEADER, one height whatever it holds: on a group, the DOOR into it —
          its size, the quiet word — and over the numbers what they count, for the lines on
          screen (held with them while the next board's read is out). */}
      <div className="board-sub">
        {tab === 'group' && active && (
          <button type="button" className="board-door" onClick={openGroup}>
            {active.members.length} {t(lang, active.members.length === 1 ? 'memberUnit' : 'membersUnit')}
            <ChevronIcon className="ui-icon" aria-hidden />
          </button>
        )}
        {shown && hasLines(shown.board, shown.tab, meId) && (
          <span className="board-unit" aria-hidden="true">
            {t(lang, isPeriodBoard(shown.board) ? 'points' : 'tries')}
          </span>
        )}
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
        {tab === 'group' && groupsPhase === 'failed' && groups === null ? (
          <LoadError message={t(lang, 'failedBoard')} lang={lang} onRetry={() => loadGroups()} />
        ) : tab === 'group' && onNone ? (
          // No group at all: the ghost and the one call.
          <div className="board-empty arrive">
            <span className="board-ghost" aria-hidden="true" />
            <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => setScreen('create')}>
              {t(lang, 'groupCreate')}
            </button>
          </div>
        ) : entry === 'failed' ? (
          <LoadError
            message={t(lang, 'failedBoard')}
            lang={lang}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        ) : shown ? (
          isPeriodBoard(shown.board) ? (
            <PeriodList
              key={shown.key}
              board={shown.board}
              lang={lang}
              meId={meId ?? undefined}
              run={{ pace: shown.pace, fold, slots }}
            />
          ) : (
            <BoardList
              key={shown.key}
              board={shown.board}
              tab={shown.tab}
              lang={lang}
              meId={meId ?? undefined}
              // Only the GLOBAL list marks the reader's people: on a group's board every
              // row is one, and marking everything marks nothing.
              mates={shown.tab === 'global' ? mates : null}
              // A group of one is the moment INVITE matters: it is the empty state's call.
              onInvite={shown.tab === 'group' ? () => void invite() : undefined}
              inviteLabel={copied ? t(lang, 'copied') : t(lang, 'boardInvite')}
              run={{ pace: shown.pace, fold, slots }}
            />
          )
        ) : (
          <Skeleton lang={lang} />
        )}
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

// THE PACE of a board's lines: when the first comes in, how far apart the next ones follow,
// and how long each number's reels run. The ARRIVAL leaves the head its beats first (the chip
// drawn across, the brackets locking on) and lands slower; a TURN comes straight in.
interface Pace {
  startMs: number;
  staggerMs: number;
  runMs: number;
}
const ARRIVE: Pace = { startMs: 260, staggerMs: 55, runMs: 650 };
const TURN: Pace = { startMs: 0, staggerMs: 30, runMs: 420 };
// The lines' PITCH: every item of a board's list — a line, a section's caption, the rail
// where rows are left out — is this tall, so the list is a column of whole slots.
const LINE_PX = 44;
// Past the FOLD (the list's last whole slot on screen, and never past PACE_CAP) the lines come
// in together with the last one shown — and so does your line held at the list's edge, which
// covers exactly that slot: the two dissolve in through the same cells at the same instant, so
// the one under it never shows through.
const PACE_CAP = 14;
const SCREEN_TILES = { ...DISSOLVES, ...EDGES } as CSSProperties;
// How a list's lines come in: the pace, the fold, and the slots the list may fill (0 until the
// body is measured: no cap on its height).
interface ListRun {
  pace: Pace;
  fold: number;
  slots: number;
}
const lineRun = ({ pace, fold }: ListRun, i: number): LineRun => ({
  delayMs: pace.startMs + Math.min(i, fold) * pace.staggerMs,
  runMs: pace.runMs,
});
const listStyle = (run: ListRun, rankDigits: number) =>
  ({
    '--rank-w': `${rankDigits * 16}px`,
    ...(run.slots > 0 ? { maxHeight: `${run.slots * LINE_PX}px` } : {}),
  }) as CSSProperties;

// The board on screen: which board, read for which tab, and the pace it came in at.
interface Shown {
  key: string;
  board: AnyBoard;
  tab: BoardTab;
  pace: Pace;
}

// Whether a board draws LINES rather than its empty state — the caption over the numbers
// waits for them. Empty is per TAB. The GLOBAL board is empty when nobody played. A GROUP's
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

// YOUR LINE STAYS IN SIGHT (CSS: sticky at both edges of the list): this says WHEN it is held
// at an edge rather than standing in its place — `data-stuck` on it, `top` or `bottom` — so
// the lines passing under it thin out through a dithered edge there instead of being cut. Its
// place is read off the line before it (the list is its lines' offset parent); `data-` because
// the line's class is React's. `mine` says whether the list draws your line at all: a refresh
// of the same board can bring it (or the list itself, after an empty state), and the watch
// then starts.
function useStuckOwnLine(mine: boolean) {
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const list = ref.current;
    const me = list?.querySelector<HTMLElement>('.board-row.me');
    if (!list || !me) return undefined;
    const read = () => {
      const before = me.previousElementSibling as HTMLElement | null;
      const top = before ? before.offsetTop + before.offsetHeight : 0;
      const stuck =
        top < list.scrollTop
          ? 'top'
          : top + me.offsetHeight > list.scrollTop + list.clientHeight
            ? 'bottom'
            : null;
      if (stuck) me.dataset.stuck = stuck;
      else delete me.dataset.stuck;
    };
    read();
    list.addEventListener('scroll', read, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    ro?.observe(list);
    return () => {
      list.removeEventListener('scroll', read);
      ro?.disconnect();
    };
  }, [mine]);
  return ref;
}

// A section's caption on the column (IN PROGRESS, NOT PLAYED YET): the words, then the
// stippled rail running on — said once for every line under it.
function Section({ text, index, run: list }: { text: string; index: number; run: ListRun }) {
  const run = lineRun(list, index);
  return (
    <li className="board-section" style={{ '--delay': `${run.delayMs}ms` } as CSSProperties}>
      <span>{text}</span>
    </li>
  );
}

// WHILE THE FIRST READ IS OUT: the board's lines as stippled rails where the marks and the
// names will stand — the box of what is coming, at its pitch, so nothing moves when it lands.
function Skeleton({ lang }: { lang: string }) {
  return (
    <div className="board-skeleton" role="status">
      <span className="sr-only">{t(lang, 'loading')}</span>
      {[62, 48, 70, 54, 40].map((width, i) => (
        <span key={i} className="board-skeleton-line" style={{ '--w': `${width}%`, '--i': i } as CSSProperties} aria-hidden="true">
          <span className="board-skeleton-mark" />
          <span className="board-skeleton-name" />
        </span>
      ))}
    </div>
  );
}

function BoardList({
  board,
  tab,
  lang,
  meId,
  mates,
  onInvite,
  inviteLabel,
  run,
}: {
  board: Board;
  tab: BoardTab;
  lang: LangCode;
  meId?: string;
  mates: ReadonlySet<string> | null;
  // A group of one: the empty state's call is INVITE.
  onInvite?: () => void;
  inviteLabel?: string;
  run: ListRun;
}) {
  const lines = hasLines(board, tab, meId ?? null);
  // (Every hook before the empty state's early return: a refresh can turn one into the other.)
  const list = useStuckOwnLine(
    lines && [...board.rows, ...(board.own ?? []), ...board.playing].some((row) => row.publicId === meId),
  );
  if (!lines) {
    return (
      <div className="board-empty arrive">
        <span className="board-ghost" aria-hidden="true" />
        <p>{t(lang, tab === 'group' ? 'boardEmptyGroup' : 'boardEmptyGlobal')}</p>
        {onInvite && (
          <button type="button" className="btn btn-primary" onClick={onInvite}>
            {inviteLabel}
          </button>
        )}
      </div>
    );
  }
  // ONE rank column for the whole list, as wide as its widest rank (two digits at the least).
  const rankDigits = Math.max(2, ...[...board.rows, ...(board.own ?? [])].map((row) => String(row.rank).length));
  let index = 0;
  const item = (row: BoardRow) => {
    const i = index++;
    return (
      <BoardRowItem
        key={row.publicId}
        row={row}
        me={row.publicId === meId}
        mate={mates?.has(row.publicId) ?? false}
        index={i}
        run={lineRun(run, i)}
        shine
      />
    );
  };
  // (Every item takes a slot, the rail too: the index is the slot it stands in.)
  const gap = () => {
    const i = index++;
    return <li className="board-gap" aria-hidden="true" style={{ '--delay': `${lineRun(run, i).delayMs}ms` } as CSSProperties} />;
  };
  return (
    <ol ref={list} className="board-list pixel-scroll" style={listStyle(run, rankDigits)}>
      {board.rows.map(item)}
      {board.own && board.own.length > 0 && (
        <>
          {gap()}
          {board.own.map(item)}
        </>
      )}
      {board.playing.length > 0 && <Section text={t(lang, 'boardPlaying')} index={index++} run={run} />}
      {board.playing.map((row) => {
        const i = index++;
        return <PlayingRowItem key={row.publicId} row={row} me={row.publicId === meId} index={i} run={lineRun(run, i)} />;
      })}
      {board.waiting.length > 0 && <Section text={t(lang, 'boardNotPlayed')} index={index++} run={run} />}
      {board.waiting.map((player) => {
        const i = index++;
        return <WaitingRowItem key={player.publicId} player={player} index={i} run={lineRun(run, i)} />;
      })}
    </ol>
  );
}

// A WEEK or a MONTH (#271): the shared period rule's three numbers per member — podium
// POINTS as the line's number, then the days and the total as a quiet detail under the name.
function PeriodList({
  board,
  lang,
  meId,
  run,
}: {
  board: PeriodBoard;
  lang: LangCode;
  meId?: string;
  run: ListRun;
}) {
  const list = useStuckOwnLine(board.rows.some((row) => row.publicId === meId));
  if (board.rows.length === 0) {
    return (
      <div className="board-empty arrive">
        <span className="board-ghost" aria-hidden="true" />
        <p>{t(lang, 'boardEmptyPeriod')}</p>
      </div>
    );
  }
  const rankDigits = Math.max(2, ...board.rows.map((row) => String(row.rank).length));
  return (
    <ol ref={list} className="board-list pixel-scroll" style={listStyle(run, rankDigits)}>
      {board.rows.map((row, index) => (
        <PeriodRowItem
          key={row.publicId}
          row={row}
          me={row.publicId === meId}
          index={index}
          lang={lang}
          run={lineRun(run, index)}
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
      <BoardRank rank={row.rank} shine={{ litMs: run.delayMs + run.runMs, seed: index + 3 }} />
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
