import { useEffect, useState, type CSSProperties } from 'react';
import {
  anonName,
  dateForDayNumber,
  defaultAvatar,
  isBoardPeriod,
  progressHeatColor,
  type Board,
  type BoardPeriod,
  type BoardPlayer,
  type BoardRow,
  type GroupSummary,
  type PeriodBoard,
  type PeriodRow,
  type PlayingRow,
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
} from '../api';
import Avatar from '../components/Avatar';
import ConfirmScreen from '../components/ConfirmScreen';
import GroupCreate from '../components/GroupCreate';
import GroupScreen from '../components/GroupScreen';
import LoadError from '../components/LoadError';
import LoadingWave from '../components/LoadingWave';
import PuzzleTitle from '../components/PuzzleTitle';
import ScopePager, { type Scope } from '../components/ScopePager';
import { HeaderLeft } from '../components/TopBar';
import useShare from '../hooks/useShare';
import useToday from '../hooks/useToday';
import {
  deviceIdentity,
  ensureRequestIdentity,
  identityEpoch,
  identityEpochOf,
  useDeviceIdentity,
} from '../identity';
import { adoptGroups, loadGroups, useGroups } from '../state/groups';
import { adoptSignedOutVerdict } from '../state/signedOutVerdict';
import { prefetchTurnstileTokens } from '../turnstile';
import ErrorScreen from '../components/ErrorScreen';
import { useGameStore } from '../state/gameStore';
import { pathForGroupInvite, type LangCode, type Mode } from '../langs';
import { t } from '../i18n';

// The #190 leaderboard screen, drawn over GROUPS since #271 (user-decided 2026-09-07:
// groups replace the friends graph — a pair of friends is a group of two). The boards are
// per (day, lang, mode), for the active day. A GROUP is the DEFAULT and the trusted
// surface — the whole point of the design (#187's anti-cheat stance: trust comes from the
// people you chose, not the global list) — with the GLOBAL top 50 as the last tab,
// explicitly the fun/untrusted view. A group has THREE boards: the DAY (finished,
// playing, waiting — the live one), and the WEEK and MONTH ranked by the shared period
// rule (podium points, then solved days, then fewer tries). This screen is also where a
// player CREATES a group, INVITES into it (the `/g/<id>` link), LEAVES it, and — as its
// owner — shows a member out.
//
// WHICH BOARD is a PAGER (user-decided 2026-09-14, the third design: a tab strip, then a
// chip opening a wheel under the header's own wheel — "come up with a totally new
// leaderboard control design"): the scopes — every group, NEW GROUP, GLOBAL — are pages
// on one horizontal line, swiped or tapped through (`ScopePager`), with the period switch
// under it as the only other control before the list. Everything there is to DO with a
// group is on the group's OWN SCREEN (`GroupScreen`, a tap on the middle page): INVITE, the
// owner's ✕ on every other member, LEAVE — the board itself carries no standing button
// ("3 huge thick buttons always on screen even if we use them 1% of the time"). Naming a
// new group is its own screen too (`GroupCreate`). LEAVING and REMOVING confirm on a
// FULL-SCREEN modal (`ConfirmScreen`), and the owner's leave carries the SUCCESSION the
// server demands (root AGENTS.md, Groups): alone, the group is deleted; with one other
// member that member takes it; with more, the owner picks one here.
//
// The rows come ranked from the server (competition ties, the plain top-50 cut, the
// own-row window, the period rule — @whippin/shared's leaderboard rules); this screen only
// draws what the API returned. Rows CONNECTED to the reader are marked in the accent: a
// quiet left edge on a member of one of your groups among the global rows, that edge plus
// a tint on your own row.
//
// **OPENING THIS SCREEN IS NOT A TRIGGER (user-decided 2026-08-24).** A navigation must not
// create server state: tokenless, the groups list is the KNOWN-EMPTY answer (#216's rule)
// and the global read stays anonymous. The deliberate acts that mint are NEW GROUP and
// INVITE, and every identity-reading effect keys on the live identity, so a mint (or a
// cross-tab adoption) populates the screen without a remount.
type Tab = 'group' | 'global';

const PERIODS: readonly BoardPeriod[] = ['day', 'week', 'month'];
type AnyBoard = Board | PeriodBoard;

const isPeriodBoard = (board: AnyBoard): board is PeriodBoard => 'from' in board;

export default function Leaderboard({ lang, mode }: { lang: LangCode; mode: Mode }) {
  // The tab belongs to the VISIT (user feedback 2026-08-20): it lives in the store because
  // this screen remounts without the visit ending, and App resets it on any non-board route.
  const tab: Tab = useGameStore((s) => s.boardTab);
  const setTab = useGameStore((s) => s.setBoardTab);
  // WHICH group: the one last opened (persisted, account-owned), else the first the
  // server lists.
  const lastGroupId = useGameStore((s) => s.lastGroupId);
  const setLastGroup = useGameStore((s) => s.setLastGroup);
  const [period, setPeriod] = useState<BoardPeriod>('day');
  // The pager's NEW GROUP page is up (a group page otherwise, when the tab is a group's).
  const [newPage, setNewPage] = useState(false);

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

  // THE SCOPES, in the pager's order: every group, NEW GROUP, GLOBAL.
  const scopes: Scope[] =
    groups === null
      ? []
      : [
          ...groups.map((group) => ({
            key: group.id,
            title: group.name,
            sub: `${group.members.length} ${t(lang, group.members.length === 1 ? 'memberUnit' : 'membersUnit')}`,
          })),
          { key: 'new', title: t(lang, 'groupNew') },
          { key: 'global', title: t(lang, 'boardGlobal'), sub: t(lang, 'scopeGlobalSub') },
        ];
  const onNew = tab === 'group' && (newPage || active === null);
  const activeIndex =
    scopes.length === 0
      ? 0
      : tab === 'global'
        ? scopes.length - 1
        : onNew || active === null
          ? scopes.length - 2
          : Math.max(0, scopes.findIndex((scope) => scope.key === active.id));
  const showScope = (index: number) => {
    const scope = scopes[index];
    if (!scope) return;
    if (scope.key === 'global') {
      setTab('global');
      setNewPage(false);
    } else if (scope.key === 'new') {
      setTab('group');
      setNewPage(true);
    } else {
      setLastGroup(scope.key);
      setTab('group');
      setNewPage(false);
    }
  };

  // ONE outcome slot per board — a board, or that board's own failure — keyed by what it
  // shows. Screen-global failure state would paint a FAILED frame over another board's
  // perfectly good rows for a render when flipping back.
  const boardKey = tab === 'global' ? 'global' : active && !onNew ? `${active.id}:${period}` : null;
  const [boards, setBoards] = useState<Partial<Record<string, AnyBoard | 'failed'>>>({});
  const [attempt, setAttempt] = useState(0);

  // THE DAY IS A LIVE VALUE: a board is left open across the 22:00-ET flip routinely, and a
  // new day is a new board, so every cache goes with it — dropped during render so
  // yesterday's rows are never committed under today's date.
  const date = dateForDayNumber(useToday());
  const [cachedDate, setCachedDate] = useState(date);
  if (cachedDate !== date) {
    setCachedDate(date);
    setBoards({});
  }
  // AND THE CACHES ARE IDENTITY-SCOPED: a board cached under a previous identity is not the
  // current account's answer, and the stale-but-good rule below would keep it over a failed
  // refresh. A scope change drops everything, exactly as a new day does.
  const [cachedEpoch, setCachedEpoch] = useState(epoch);
  if (cachedEpoch !== epoch) {
    setCachedEpoch(epoch);
    setBoards({});
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
          const response = await postBoardBody(boardUrl(lang, date, mode), {
            token: identity.token,
            group: active.id,
            ...(period === 'day' ? {} : { period }),
          });
          if (cancelled || (epochNow !== null && identityEpoch() !== epochNow)) return;
          if (!response.ok) {
            await adoptSignedOutVerdict(response, epochNow ?? '');
            // Not a member any more (left elsewhere, removed): the list is what is stale.
            if (response.status === 403) loadGroups(true);
            throw new Error(`board answered ${response.status}`);
          }
          const data: unknown = await response.json();
          board = period === 'day' ? parseBoard(data) : parsePeriodBoard(data);
        } else {
          const response = await fetch(boardUrl(lang, date, mode, identity?.accountId));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardKey, tab, active?.id, period, lang, mode, date, attempt, identity]);

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
        request = await ensureRequestIdentity(null);
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

  const create = async (name: string) => {
    if (busy) return;
    const result = await write('create', (token) => ({ token, create: true, name }));
    if (result.ok && result.created) {
      setLastGroup(result.created);
      setTab('group');
      setNewPage(false);
      setPeriod('day');
      setScreen(null);
    }
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

  const creator = active !== null && active.createdBy === meId;
  // The succession the LEAVE carries, read off the list the server last answered (the
  // same rule the server applies — `successionFor`): who else is in the group decides
  // whether the owner names somebody. A list gone stale by the time the tap lands is the
  // server's 409 `successor_required`, which re-reads the list below.
  const others = active ? active.members.filter((id) => id !== meId) : [];
  const leaveKind = !creator
    ? 'plain'
    : others.length === 0
      ? 'last'
      : others.length === 1
        ? 'handover'
        : 'pick';

  // Opening the owner's leave with a choice to make DRESSES the candidates.
  useEffect(() => {
    if (confirming?.kind !== 'leave' || leaveKind !== 'pick' || !active) return;
    const controller = new AbortController();
    void readGroup(active.id, controller.signal).then((read) => {
      if (read.status !== 'shown' || controller.signal.aborted) return;
      setFaces(Object.fromEntries(read.group.members.map((member) => [member.publicId, member])));
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirming?.kind, leaveKind, active?.id]);

  const leave = async () => {
    if (busy || !active) return;
    if (leaveKind === 'pick' && successor === null) return;
    const id = active.id;
    const named = leaveKind === 'pick' ? successor : null;
    const result = await write('leave', (token) => ({ token, leave: id, ...(named ? { successor: named } : {}) }));
    setConfirming(null);
    setSuccessor(null);
    if (result.ok) {
      setScreen(null);
    } else if (result.error === 'successor_required') {
      // The list this screen decided from was stale: re-read it, and the next LEAVE asks.
      loadGroups(true);
    }
  };

  const remove = async (member: string) => {
    if (busy || !active) return;
    const result = await write('remove', (token) => ({ token, remove: active.id, member }));
    setConfirming(null);
    if (result.ok) setAttempt((n) => n + 1);
  };

  return (
    <div className="board-screen">
      {/* THE BOARD KEEPS THE PUZZLE'S TITLE and takes no title of its own (user-decided
          2026-08-30): a board is a view OF a daily, and the lit crown says what the screen
          is. The way OUT is any other key of the same, unmoving row. */}
      <HeaderLeft>
        <PuzzleTitle lang={lang} mode={mode} surface="board" />
      </HeaderLeft>

      {/* WHICH BOARD: the pager. A tap on the middle page goes into it — the group's own
          screen, the create screen on NEW GROUP; GLOBAL has nothing to open. */}
      {scopes.length > 0 ? (
        <ScopePager
          lang={lang}
          scopes={scopes}
          active={activeIndex}
          onChange={showScope}
          onOpen={(index) => {
            const key = scopes[index]?.key;
            if (key === 'new') setScreen('create');
            else if (key !== 'global' && key !== undefined) setScreen('group');
          }}
        />
      ) : (
        <div className="scope scope-blank" aria-hidden />
      )}

      {/* WHICH of the group's three boards: one framed switch, three equal cells. */}
      {tab === 'group' && active && !onNew && (
        <nav className="board-tabs period-tabs" aria-label={t(lang, 'boardPeriods')}>
          {PERIODS.map((view) => (
            <button
              key={view}
              type="button"
              className={`board-tab${period === view ? ' active' : ''}`}
              aria-current={period === view || undefined}
              onClick={() => isBoardPeriod(view) && setPeriod(view)}
            >
              {t(lang, view === 'day' ? 'periodDay' : view === 'week' ? 'periodWeek' : 'periodMonth')}
            </button>
          ))}
        </nav>
      )}

      <div className="board-body">
        {tab === 'group' && groupsPhase === 'failed' && groups === null ? (
          <LoadError message={t(lang, 'failedBoard')} lang={lang} onRetry={() => loadGroups(true)} />
        ) : tab === 'group' && onNew ? (
          // The NEW GROUP page: the ghost (over its word while the player has no group at
          // all) and the one call.
          <div className="board-empty">
            <span className="board-ghost" aria-hidden="true" />
            {groups !== null && groups.length === 0 && <p>{t(lang, 'boardEmptyGroups')}</p>}
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
        ) : board ? (
          isPeriodBoard(board) ? (
            <PeriodList key={boardKey} board={board} lang={lang} mode={mode} meId={meId ?? undefined} />
          ) : (
            <BoardList
              key={boardKey}
              board={board}
              tab={tab}
              lang={lang}
              mode={mode}
              meId={meId ?? undefined}
              // Only the GLOBAL list marks the reader's people: on a group's board every
              // row is one, and marking everything marks nothing.
              mates={tab === 'global' ? mates : null}
              // A group of one is the moment INVITE matters: it is the empty state's call.
              onInvite={tab === 'group' ? () => void invite() : undefined}
              inviteLabel={copied ? t(lang, 'copied') : t(lang, 'boardInvite')}
            />
          )
        ) : (
          <p className="status">
            <LoadingWave text={t(lang, 'loading')} />
          </p>
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
        <GroupCreate lang={lang} busy={busy === 'create'} onCreate={(name) => void create(name)} onClose={() => setScreen(null)} />
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
            <div className="board-list confirm-pick" role="radiogroup" aria-label={t(lang, 'groupMembers')}>
              {others.map((id, index) => {
                const face = faces[id];
                const picked = successor === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={picked}
                    className={`board-row waiting${picked ? ' picked' : ''}`}
                    style={{ '--i': index } as CSSProperties}
                    onClick={() => setSuccessor(id)}
                  >
                    <span className="board-norank" aria-hidden="true" />
                    <Avatar avatar={face?.avatar ?? defaultAvatar(id)} size={28} />
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

function BoardList({
  board,
  tab,
  lang,
  mode,
  meId,
  mates,
  onInvite,
  inviteLabel,
}: {
  board: Board;
  tab: Tab;
  lang: LangCode;
  mode: Mode;
  meId?: string;
  mates: ReadonlySet<string> | null;
  // A group of one: the empty state's call is INVITE.
  onInvite?: () => void;
  inviteLabel?: string;
}) {
  // Empty is per TAB. The GLOBAL board is empty when nobody played. A GROUP's board is
  // empty when the caller is ALONE in it: the server includes the caller's own row once
  // they played, and a board of exactly yourself still means "nobody else yet", which is
  // what the ghost says and INVITE below remedies (a member who merely has not played is
  // a waiting row, never empty).
  const others = board.rows.filter((row) => row.publicId !== meId);
  const playingOthers = board.playing.filter((row) => row.publicId !== meId);
  const empty =
    (tab === 'group' ? others.length === 0 && playingOthers.length === 0 : board.rows.length === 0) &&
    (board.own?.length ?? 0) === 0 &&
    board.waiting.length === 0;
  if (empty) {
    return (
      <div className="board-empty">
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
  let index = 0;
  const item = (row: BoardRow) => (
    <BoardRowItem
      key={row.publicId}
      row={row}
      me={row.publicId === meId}
      mate={mates?.has(row.publicId) ?? false}
      index={index++}
    />
  );
  return (
    <>
      {(board.rows.length > 0 || board.playing.length > 0) && (
        <div className="board-unit" aria-hidden="true">
          {t(lang, mode === 'word' ? 'words' : 'tries')}
        </div>
      )}
      <ol className="board-list pixel-scroll">
        {board.rows.map(item)}
        {board.own && board.own.length > 0 && (
          <>
            <li className="board-gap" aria-hidden="true" />
            {board.own.map(item)}
          </>
        )}
        {board.playing.length > 0 && <li className="board-section">{t(lang, 'boardPlaying')}</li>}
        {board.playing.map((row) => (
          <PlayingRowItem
            key={row.publicId}
            row={row}
            me={row.publicId === meId}
            index={index++}
          />
        ))}
        {board.waiting.length > 0 && <li className="board-section">{t(lang, 'boardNotPlayed')}</li>}
        {board.waiting.map((player) => (
          <WaitingRowItem key={player.publicId} player={player} index={index++} />
        ))}
      </ol>
    </>
  );
}

// A WEEK or a MONTH (#271): the shared period rule's three numbers per member — podium
// POINTS under the caption, then the days and the total as the row's quiet detail.
function PeriodList({
  board,
  lang,
  mode,
  meId,
}: {
  board: PeriodBoard;
  lang: LangCode;
  mode: Mode;
  meId?: string;
}) {
  if (board.rows.length === 0) {
    return (
      <div className="board-empty">
        <span className="board-ghost" aria-hidden="true" />
        <p>{t(lang, 'boardEmptyPeriod')}</p>
      </div>
    );
  }
  return (
    <>
      <div className="board-unit" aria-hidden="true">
        {t(lang, 'points')}
      </div>
      <ol className="board-list pixel-scroll">
        {board.rows.map((row, index) => (
          <PeriodRowItem key={row.publicId} row={row} me={row.publicId === meId} index={index} lang={lang} mode={mode} />
        ))}
      </ol>
    </>
  );
}

function PeriodRowItem({
  row,
  me,
  index,
  lang,
  mode,
}: {
  row: PeriodRow;
  me: boolean;
  index: number;
  lang: LangCode;
  mode: Mode;
}) {
  return (
    <li className={`board-row period${me ? ' me' : ''}`} style={{ '--i': index } as CSSProperties} aria-current={me || undefined}>
      <span className="board-rank">#{row.rank}</span>
      <Avatar avatar={row.avatar ?? defaultAvatar(row.publicId)} size={28} />
      <span className="board-ident">
        <span className={`board-name${row.name ? '' : ' anon'}`}>{row.name || anonName(row.publicId)}</span>
        {/* The tiebreakers, said small under the name: the days that recorded a score,
            and the total in the mode's own unit. */}
        <span className="board-detail">
          {row.solvedDays} {t(lang, row.solvedDays === 1 ? 'dayUnit' : 'daysUnit')} · {row.total}{' '}
          {t(lang, mode === 'word' ? 'words' : 'tries').toLowerCase()}
        </span>
      </span>
      <span className="board-score">{row.points}</span>
    </li>
  );
}

// WHO is at stake, over a confirmation: the mark and the name, the crossroads' own stack.
function Face({ player }: { player: BoardPlayer }) {
  return (
    <span className="confirm-face">
      <Avatar avatar={player.avatar ?? defaultAvatar(player.publicId)} size={44} />
      <span className={`confirm-name${player.name ? '' : ' anon'}`}>{player.name || anonName(player.publicId)}</span>
    </span>
  );
}

function PlayingRowItem({
  row,
  me,
  index,
  trailing = null,
}: {
  row: PlayingRow;
  me: boolean;
  index: number;
  trailing?: React.ReactNode;
}) {
  return (
    <li
      className={`board-row playing${me ? ' me' : ''}${trailing ? ' managed' : ''}`}
      style={{ '--i': index, '--play-heat': progressHeatColor(row.progress) } as CSSProperties}
      aria-current={me || undefined}
    >
      <span className="board-norank" aria-hidden="true" />
      <Avatar avatar={row.avatar ?? defaultAvatar(row.publicId)} size={28} />
      <span className={`board-name${row.name ? '' : ' anon'}`}>{row.name || anonName(row.publicId)}</span>
      <span className="board-progress">{Math.round(row.progress)}%</span>
      <span className="board-score">{row.tries}</span>
      {trailing}
    </li>
  );
}

function WaitingRowItem({
  player,
  index,
  trailing = null,
}: {
  player: BoardPlayer;
  index: number;
  trailing?: React.ReactNode;
}) {
  return (
    <li className={`board-row waiting${trailing ? ' managed' : ''}`} style={{ '--i': index } as CSSProperties}>
      <span className="board-norank" aria-hidden="true" />
      <Avatar avatar={player.avatar ?? defaultAvatar(player.publicId)} size={28} />
      <span className={`board-name${player.name ? '' : ' anon'}`}>{player.name || anonName(player.publicId)}</span>
      {trailing}
    </li>
  );
}

function BoardRowItem({
  row,
  me,
  mate,
  index,
  trailing = null,
}: {
  row: BoardRow;
  me: boolean;
  mate: boolean;
  index: number;
  trailing?: React.ReactNode;
}) {
  return (
    <li
      // `me` wins over `mate`: your own row is never one of your people, but a stale list
      // could say so, and two markers on one row is a rendering bug on screen.
      className={`board-row${me ? ' me' : mate ? ' mate' : ''}${trailing ? ' managed' : ''}`}
      style={{ '--i': index } as CSSProperties}
      aria-current={me || undefined}
    >
      <span className="board-rank">#{row.rank}</span>
      <Avatar avatar={row.avatar ?? defaultAvatar(row.publicId)} size={28} />
      <span className={`board-name${row.name ? '' : ' anon'}`}>{row.name || anonName(row.publicId)}</span>
      <span className="board-score">{row.score}</span>
      {trailing}
    </li>
  );
}
