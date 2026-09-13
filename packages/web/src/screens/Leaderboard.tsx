import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import {
  anonName,
  dateForDayNumber,
  defaultAvatar,
  isBoardPeriod,
  NAME_MAX_LENGTH,
  progressHeatColor,
  sanitizeName,
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
} from '../api';
import Avatar from '../components/Avatar';
import LoadError from '../components/LoadError';
import LoadingWave from '../components/LoadingWave';
import PuzzleTitle from '../components/PuzzleTitle';
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
// creator — shows a member out.
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
  // WHICH group: the one last opened (persisted, account-owned — the standing line reads
  // it too), else the first the server lists.
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
  const active: GroupSummary | null =
    groups === null
      ? null
      : (groups.find((group) => group.id === lastGroupId) ?? groups[0] ?? null);
  // The reader's own people, for marking rows among the global ones: the union of every
  // group they are in, which the list already carries.
  const mates = new Set(groups?.flatMap((group) => group.members) ?? []);

  // ONE outcome slot per board — a board, or that board's own failure — keyed by what it
  // shows. Screen-global failure state would paint a FAILED frame over another board's
  // perfectly good rows for a render when flipping back.
  const boardKey = tab === 'global' ? 'global' : active ? `${active.id}:${period}` : null;
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

  // One fetch per board ACTIVATION — the route is a zero-TTL live read, so a tab flip
  // re-reads rather than trusting a snapshot; the cached board holds the screen while the
  // fresh one is in flight (stale-but-good beats a spinner), and RETRY refetches. A GROUP
  // board is the authenticated POST naming the group (the server refuses a non-member);
  // GLOBAL is the anonymous GET, widened with the caller's own window via their PUBLIC id.
  useEffect(() => {
    if (boardKey === null) return;
    const key = boardKey;
    let cancelled = false;
    setBoards((prev) => (prev[key] === 'failed' ? { ...prev, [key]: undefined } : prev));
    // No token, no private fetch (#216): a group tab cannot exist tokenless (the list is
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

  // ---- the deliberate acts: NEW GROUP, INVITE, LEAVE, REMOVE. Each write answers the
  // list as it now stands, published through `adoptGroups`; a failure lands on the app's
  // error surface, since saying nothing leaves the player tapping a button that appears to
  // do nothing.
  const [busy, setBusy] = useState<'create' | 'invite' | 'leave' | 'remove' | null>(null);
  const [failure, setFailure] = useState<'account' | 'share' | 'group' | 'limit' | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  // A two-tap confirm for the two destructive taps: LEAVE, and a member's ✕.
  const [confirm, setConfirm] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
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

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const clean = sanitizeName(name);
    if (busy || clean.length === 0) return;
    const result = await write('create', (token) => ({ token, create: true, name: clean }));
    if (result.ok && result.created) {
      setLastGroup(result.created);
      setTab('group');
      setPeriod('day');
      setCreating(false);
      setName('');
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

  const leave = async () => {
    if (busy || !active) return;
    if (confirm !== `leave:${active.id}`) {
      setConfirm(`leave:${active.id}`);
      return;
    }
    setConfirm(null);
    setManaging(false);
    await write('leave', (token) => ({ token, leave: active.id }));
  };

  const remove = async (member: string) => {
    if (busy || !active) return;
    if (confirm !== `remove:${member}`) {
      setConfirm(`remove:${member}`);
      return;
    }
    setConfirm(null);
    const result = await write('remove', (token) => ({ token, remove: active.id, member }));
    if (result.ok) setAttempt((n) => n + 1);
  };

  const creator = active !== null && active.createdBy === meId;

  return (
    <div className="board-screen">
      {/* THE BOARD KEEPS THE PUZZLE'S TITLE and takes no title of its own (user-decided
          2026-08-30): a board is a view OF a daily, and the lit crown says what the screen
          is. The way OUT is any other key of the same, unmoving row. */}
      <HeaderLeft>
        <PuzzleTitle lang={lang} mode={mode} surface="board" />
      </HeaderLeft>

      {/* THE GROUPS first — the trusted default — then NEW, then GLOBAL, the fun view. The
          strip scrolls sideways once the names outrun it; the segmented control is the
          header mode switcher's own dress. */}
      <nav className="board-tabs group-tabs" aria-label={t(lang, 'boardTitle')}>
        {(groups ?? []).map((group) => (
          <button
            key={group.id}
            type="button"
            className={`board-tab${tab === 'group' && active?.id === group.id ? ' active' : ''}`}
            aria-current={(tab === 'group' && active?.id === group.id) || undefined}
            onClick={() => {
              setLastGroup(group.id);
              setTab('group');
              setConfirm(null);
              setManaging(false);
            }}
          >
            {group.name}
          </button>
        ))}
        <button
          type="button"
          className="board-tab board-tab-new"
          aria-label={t(lang, 'groupNew')}
          onClick={() => setCreating((open) => !open)}
        >
          +
        </button>
        <button
          type="button"
          className={`board-tab${tab === 'global' ? ' active' : ''}`}
          aria-current={tab === 'global' || undefined}
          onClick={() => setTab('global')}
        >
          {t(lang, 'boardGlobal')}
        </button>
      </nav>

      {/* NEW GROUP: a name — the player name's own charset, never empty — and CREATE, which
          is a deploy button: a tokenless tap mints the account and then creates. */}
      {creating && (
        <form className="group-form" onSubmit={(event) => void create(event)}>
          <input
            className="group-form-input"
            type="text"
            value={name}
            maxLength={NAME_MAX_LENGTH}
            placeholder={t(lang, 'groupNamePlaceholder')}
            aria-label={t(lang, 'groupName')}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(event) => setName(sanitizeName(event.target.value))}
          />
          <button
            type="submit"
            className="btn btn-primary group-form-submit"
            disabled={busy !== null || sanitizeName(name).length === 0}
          >
            {busy === 'create' ? <LoadingWave text={t(lang, 'loading')} /> : t(lang, 'groupCreate')}
          </button>
        </form>
      )}

      {/* WHICH of the group's three boards. */}
      {tab === 'group' && active && (
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
        {tab === 'group' && groups !== null && groups.length === 0 ? (
          // No group at all: the sad ghost over one terse line; NEW GROUP below remedies it.
          <div className="board-empty">
            <span className="board-ghost" aria-hidden="true" />
            <p>{t(lang, 'boardEmptyGroups')}</p>
          </div>
        ) : tab === 'group' && groupsPhase === 'failed' && groups === null ? (
          <LoadError message={t(lang, 'failedBoard')} lang={lang} onRetry={() => loadGroups(true)} />
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
              onRemove={managing && creator ? remove : undefined}
              confirming={confirm}
            />
          )
        ) : (
          <p className="status">
            <LoadingWave text={t(lang, 'loading')} />
          </p>
        )}
      </div>

      {/* A group's own two quiet acts under its board: LEAVE, and — for its creator —
          MANAGE, which turns every row's end into a ✕. Both destructive taps confirm on a
          second tap by changing their own word, never with a dialog. */}
      {tab === 'group' && active && (
        <div className="group-actions">
          <button type="button" className="link-quiet-btn" disabled={busy !== null} onClick={() => void leave()}>
            {busy === 'leave'
              ? t(lang, 'loading')
              : confirm === `leave:${active.id}`
                ? t(lang, 'groupLeaveConfirm')
                : t(lang, 'groupLeave')}
          </button>
          {creator && period === 'day' && (
            <button
              type="button"
              className="link-quiet-btn"
              onClick={() => {
                setManaging((open) => !open);
                setConfirm(null);
              }}
            >
              {t(lang, managing ? 'groupManageDone' : 'groupManage')}
            </button>
          )}
        </div>
      )}

      {/* The screen's one big action, on the column's bottom edge: INVITE into the group
          on screen, or NEW GROUP when there is none. Both are deploy triggers for a
          tokenless device (the tap mints, then acts, holding a LoadingWave). */}
      {tab === 'group' && active ? (
        <button
          type="button"
          className="mix-btn board-invite"
          disabled={busy !== null}
          onClick={() => void invite()}
        >
          {copied ? t(lang, 'copied') : t(lang, 'boardInvite')}
        </button>
      ) : (
        <button
          type="button"
          className="mix-btn board-invite"
          disabled={busy !== null}
          onClick={() => setCreating(true)}
        >
          {t(lang, 'groupNew')}
        </button>
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
  onRemove,
  confirming,
}: {
  board: Board;
  tab: Tab;
  lang: LangCode;
  mode: Mode;
  meId?: string;
  mates: ReadonlySet<string> | null;
  onRemove?: (publicId: string) => void;
  confirming: string | null;
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
      </div>
    );
  }
  let index = 0;
  const removal = (publicId: string) =>
    onRemove && publicId !== meId ? (
      <RemoveButton
        lang={lang}
        confirming={confirming === `remove:${publicId}`}
        onClick={() => onRemove(publicId)}
      />
    ) : null;
  const item = (row: BoardRow) => (
    <BoardRowItem
      key={row.publicId}
      row={row}
      me={row.publicId === meId}
      mate={mates?.has(row.publicId) ?? false}
      index={index++}
      trailing={removal(row.publicId)}
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
            trailing={removal(row.publicId)}
          />
        ))}
        {board.waiting.length > 0 && <li className="board-section">{t(lang, 'boardNotPlayed')}</li>}
        {board.waiting.map((player) => (
          <WaitingRowItem key={player.publicId} player={player} index={index++} trailing={removal(player.publicId)} />
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

function RemoveButton({
  lang,
  confirming,
  onClick,
}: {
  lang: LangCode;
  confirming: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`board-remove${confirming ? ' confirming' : ''}`}
      aria-label={t(lang, 'groupRemove')}
      onClick={onClick}
    >
      {confirming ? t(lang, 'groupRemoveConfirm') : '✕'}
    </button>
  );
}

function PlayingRowItem({
  row,
  me,
  index,
  trailing,
}: {
  row: PlayingRow;
  me: boolean;
  index: number;
  trailing: React.ReactNode;
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
  trailing,
}: {
  player: BoardPlayer;
  index: number;
  trailing: React.ReactNode;
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
  trailing,
}: {
  row: BoardRow;
  me: boolean;
  mate: boolean;
  index: number;
  trailing: React.ReactNode;
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
