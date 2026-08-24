import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  anonName,
  dateForDayNumber,
  defaultAvatar,
  type Board,
  type BoardPlayer,
  type BoardRow,
} from '@whippin/shared';
import {
  boardUrl,
  friendsUrl,
  parseBoard,
  parseFriends,
  parseProfile,
  postBoardBody,
  postFriendsBody,
  profileUrl,
} from '../api';
import Avatar from '../components/Avatar';
import LoadError from '../components/LoadError';
import LoadingWave from '../components/LoadingWave';
import ModeTabs from '../components/ModeTabs';
import TopBar from '../components/TopBar';
import useShare from '../hooks/useShare';
import useToday from '../hooks/useToday';
import {
  ensureRequestIdentity,
  identityEpoch,
  identityEpochOf,
  markDeviceSignedOut,
  useDeviceIdentity,
} from '../identity';
import { useGameStore, type BoardTab } from '../state/gameStore';
import {
  pathForBoard,
  pathForInvite,
  pathForMode,
  PROFILE_PATH,
  type LangCode,
  type Mode,
} from '../langs';
import { navigate } from '../routing';
import { t } from '../i18n';
import CloseIcon from '../assets/icons/close.svg?react';

// The #190 leaderboard screen: the day's boards per (day, lang, mode), for the active
// day. FRIENDS is the DEFAULT and the trusted surface — the whole point of the design
// (#187's anti-cheat stance: trust comes from the graph, not the global list) — with
// the GLOBAL top 50 as the second tab, explicitly the fun/untrusted view. This screen
// is also where a player customizes their profile (#188 — the EDIT chip onto /profile)
// and shares their invite link (#189 — the INVITE button), neither of which requires
// having played, which is why the header icon reaches it before a first guess.
//
// The rows come ranked from the server (competition ties, the plain top-50 cut, the
// own-row window — @whippin/shared's leaderboard rules); this screen only draws what
// the API returned. Rows CONNECTED to the reader are marked in the accent — the app's
// "you are here" colour: a quiet left edge on a friend, that edge plus a tint on your
// own row (user-decided 2026-08-20, see the CSS).
//
// **OPENING THIS SCREEN IS NOT A TRIGGER (user-decided 2026-08-24, superseding "opening
// the leaderboard mints an account").** A navigation must not create server state: a
// signed-out or brand-new visitor browsing here would otherwise silently spawn an
// account. Tokenless, every private face is the KNOWN-EMPTY answer (#216's rule): the
// friends board is the ghost + INVITE without a request, the identity strip draws
// nothing (there is no identity to show), and the global read stays genuinely anonymous.
// The deliberate act that mints is the INVITE tap — the one thing on this screen that
// cannot exist without an account — and every identity-reading effect keys on the live
// identity, so a mint (or a cross-tab adoption) populates the strip and the boards
// without a remount.
type Tab = BoardTab;

// What the strip shows for the player. The publicId is derived locally and is available
// first; the NAME and MARK are only ever shown RESOLVED — see the read below.
interface Me {
  publicId: string;
  name: string;
  avatar: string | null;
}

// The tokenless FRIENDS board: a device with no account holds no edges and no rows, so
// this is the KNOWN-EMPTY answer (#216), installed synchronously — at first render and at
// every identity-scope reset — so a tokenless visit never flashes a LOADING frame for a
// request nobody makes.
const EMPTY_FRIENDS_BOARD: Board = { rows: [], own: null, waiting: [] };
const boardsFor = (identity: unknown): Partial<Record<Tab, Board | 'failed'>> =>
  identity ? {} : { friends: EMPTY_FRIENDS_BOARD };

export default function Leaderboard({ lang, mode }: { lang: LangCode; mode: Mode }) {
  // The tab belongs to the VISIT, and it lives in the store because this screen remounts
  // without the visit ending — a header mode switch (App keys it on lang:mode) and a page
  // refresh both did, and local state dropped a player who had chosen GLOBAL back onto
  // FRIENDS both times. LEAVING the leaderboard is what ends the visit, and App owns that
  // reset (user feedback 2026-08-20).
  const tab = useGameStore((s) => s.boardTab);
  const setTab = useGameStore((s) => s.setBoardTab);

  // The device's live identity (#216). Opening this screen is NOT a trigger (user-decided
  // 2026-08-24): the strip, the boards and the friend marks all READ whatever identity the
  // device holds, and only the INVITE tap below ever creates one. Keying the effects on
  // this value is what populates the screen when an identity ARRIVES under it — the invite
  // tap's own mint, or an adoption from another tab — where a run-once effect left the
  // strip blank and the invite dead until a remount (review finding). It leads the state
  // below because the TOKENLESS answers are derived from it SYNCHRONOUSLY: known-empty is
  // an initializer's value, never an effect's, or the first paint flashes a skeleton and a
  // LOADING wave for requests nobody makes.
  const identity = useDeviceIdentity();
  const epoch = identity ? identityEpochOf(identity) : null;

  const [me, setMe] = useState<Me | null>(null);
  // The id alone, available as soon as the identity is: it is what the own-row marker
  // needs, which never waits on a profile. Pure derivation — state here would only ever
  // mirror the identity, one sync hazard for nothing.
  const meId = identity?.accountId ?? null;
  // Whether the identity READ is over (however it ended). The strip holds a skeleton
  // until it is — never a name (user feedback 2026-08-20). Tokenless there is nothing to
  // read: settled empty from the first frame.
  const [meSettled, setMeSettled] = useState(() => identity === null);
  // The reader's edges, for marking friends among the global rows. Decoration, fetched
  // lazily and only for the tab that needs it.
  const [friendIds, setFriendIds] = useState<ReadonlySet<string> | null>(null);
  // ONE outcome slot per tab — a board, or that tab's own failure. Screen-global
  // failure state painted a FAILED frame over the other tab's perfectly good board for
  // a render when flipping back (review finding, 2026-08-20).
  const [boards, setBoards] = useState<Partial<Record<Tab, Board | 'failed'>>>(() =>
    boardsFor(identity),
  );
  const [attempt, setAttempt] = useState(0);
  const setProfileReturn = useGameStore((s) => s.setProfileReturn);

  // THE DAY IS A LIVE VALUE, not a clock read at fetch time (review finding,
  // 2026-08-20). A board is addressed per (day, lang, mode), and this screen can be
  // left open across the 22:00-ET flip — on a phone, overnight, routinely. `useToday`
  // is the app's one day signal: it re-fires at the DST-correct reset AND on a
  // visibility flip (the case a throttled background timer would otherwise miss).
  const date = dateForDayNumber(useToday());
  // A NEW DAY IS A NEW BOARD, so both tabs' caches go with it — dropped during render
  // (React's own "adjust state when a prop changes" shape) rather than in an effect, so
  // yesterday's rows are never committed under today's date, and the fetch below is
  // already keyed on the new day when it runs.
  const [cachedDate, setCachedDate] = useState(date);
  if (cachedDate !== date) {
    setCachedDate(date);
    setBoards(boardsFor(identity));
  }
  // AND THE CACHES ARE IDENTITY-SCOPED (PR-219 follow-up review): a board cached tokenless
  // — or under a previous identity — is not the current account's answer, and the
  // stale-but-good rule below deliberately keeps a cached board over a FAILED refresh, so
  // a kept tokenless-empty board would suppress both the adopted account's real data and
  // the retry UI. A scope change therefore drops both tabs, the friend marks and the strip
  // during render, exactly as a new day does; what replaces them is the new scope's own
  // synchronous answer.
  const [cachedEpoch, setCachedEpoch] = useState(epoch);
  if (cachedEpoch !== epoch) {
    setCachedEpoch(epoch);
    setBoards(boardsFor(identity));
    setFriendIds(null);
    setMe(null);
    setMeSettled(identity === null);
  }
  // The pinned `share` analytics event means "a RESULT left the app" (the three-event
  // invariant); an invite link is not a result, so its delivery is untracked rather
  // than quietly redefining the metric.
  const { share, copied } = useShare({ tracked: false });

  // The identity strip: ONE read settles what it says — for the identity the device
  // already holds. With none there is nothing to resolve and nothing to show: settled
  // empty, an ANSWER, never a skeleton with no request behind it.
  //
  // Nothing is shown until the read settles (user feedback 2026-08-20). The first cut
  // published the id the moment it derived, which rendered the ASSIGNED identity — the
  // pseudonym and the generated mark — and then swapped it for the real profile a beat
  // later: a player with a name watched someone else's name flash under their own avatar
  // on every visit. A skeleton says "not yet"; a name says something false.
  //
  // A read that FAILS still settles, on the assigned identity: it is what a board row
  // whose profile read failed already shows, and a skeleton that never resolves is the
  // one outcome worse than the fallback. A 404 is not a failure at all — it is the
  // answer "never customized", whose display IS the assigned identity.
  useEffect(() => {
    // Tokenless is already the settled-empty answer, derived synchronously above — there
    // is nothing to read and nothing to show.
    if (!identity) return;
    let cancelled = false;
    const publicId = identity.accountId;
    const epoch = identityEpochOf(identity);
    (async () => {
      let resolved: Me = { publicId, name: '', avatar: null };
      try {
        const response = await fetch(profileUrl(publicId));
        if (identityEpoch() !== epoch) return;
        if (response.ok) {
          const profile = parseProfile(await response.json());
          if (identityEpoch() !== epoch) return;
          resolved = { publicId, name: profile.name, avatar: profile.avatar };
        }
      } catch {
        // Keep the assigned identity.
      }
      if (cancelled || identityEpoch() !== epoch) return;
      setMe(resolved);
      setMeSettled(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [identity]);

  // The reader's OWN EDGES, for marking friends among the global rows (user-asked,
  // 2026-08-20). Fetched only when the GLOBAL tab is actually shown and only once per
  // visit: the friends board's rows are friends by construction, so nothing there needs
  // marking, and the graph does not change with the day the board is addressed by.
  // Decoration — a failure simply leaves the rows unmarked, never an error.
  useEffect(() => {
    if (tab !== 'global' || friendIds) return;
    // No identity means no edges: unmarked rows are the honest board, and asking would
    // bootstrap an account for a navigation (#216 — reads never mint).
    if (!identity) return;
    let cancelled = false;
    (async () => {
      try {
        const epoch = identityEpochOf(identity);
        const response = await postFriendsBody(friendsUrl(), { token: identity.token });
        if (cancelled || identityEpoch() !== epoch) return;
        if (!response.ok) {
          // Unmarked rows are a fine board, so this read fails silently — EXCEPT for the one
          // answer that is not about the read at all. A device revoked since the board
          // mounted can learn it here first, and swallowing it would leave the screen
          // decorating a board for an account it no longer holds.
          if (response.status === 401) {
            const data = (await response.json().catch(() => ({}))) as { error?: unknown };
            if (data.error === 'unknown_device') markDeviceSignedOut(epoch);
          }
          return;
        }
        const ids = parseFriends(await response.json());
        if (!cancelled && identityEpoch() === epoch) setFriendIds(new Set(ids));
      } catch {
        // Unmarked rows are a fine board.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, friendIds, identity]);

  // One fetch per tab ACTIVATION — the route is a zero-TTL live read, so a tab flip
  // re-reads rather than trusting a snapshot from minutes ago; the cached board holds
  // the screen while the fresh one is in flight (stale-but-good beats a spinner), and
  // RETRY refetches. FRIENDS is the authenticated POST — the server resolves YOUR
  // edges, so the read has to prove who is asking (#216: the device token in the body,
  // never a query string). GLOBAL is the anonymous GET, widened with the caller's own
  // window via their PUBLIC id.
  useEffect(() => {
    let cancelled = false;
    // A standing failure turns back into the loading state for this pass.
    setBoards((prev) => (prev[tab] === 'failed' ? { ...prev, [tab]: undefined } : prev));
    // **No token, no private fetch (#216)** — and no MINT for a navigation (user-decided
    // 2026-08-24): the tokenless FRIENDS board is the KNOWN-EMPTY answer, already
    // installed synchronously (`boardsFor`) — the ghost and the INVITE button, exactly
    // what a brand-new visitor should see, with no request behind it. The GLOBAL read
    // below needs no identity: the caller's public id only ever widens it with their own
    // window.
    if (tab === 'friends' && !identity) return;
    (async () => {
      const epoch = identity ? identityEpochOf(identity) : null;
      try {
        const response =
          tab === 'friends' && identity !== null
            ? await postBoardBody(boardUrl(lang, date, mode), { token: identity.token })
            : await fetch(boardUrl(lang, date, mode, identity?.accountId));
        if (cancelled || (epoch !== null && identityEpoch() !== epoch)) return;
        if (!response.ok) {
          if (response.status === 401) {
            const data = (await response.json().catch(() => ({}))) as { error?: unknown };
            if (data.error === 'unknown_device' && epoch !== null) markDeviceSignedOut(epoch);
          }
          throw new Error(`board answered ${response.status}`);
        }
        const board = parseBoard(await response.json());
        if (!cancelled && (epoch === null || identityEpoch() === epoch)) {
          setBoards((prev) => ({ ...prev, [tab]: board }));
        }
      } catch {
        // FAILED only when there is nothing to show: an error frame over rows already
        // on screen helps nobody — the cached board stands until a refresh succeeds.
        if (!cancelled && (epoch === null || identityEpoch() === epoch)) {
          setBoards((prev) =>
            prev[tab] && prev[tab] !== 'failed' ? prev : { ...prev, [tab]: 'failed' },
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, lang, mode, date, attempt, identity]);

  const entry = boards[tab];
  const board = entry === 'failed' ? undefined : entry;

  // The INVITE tap's own state: its bootstrap in flight, and what the line above the
  // button says. LOUD on every outcome that is not the share sheet itself, the Word
  // gate's rule: the tap exists to deliver a link, and saying nothing leaves the player
  // tapping a button that appears to do nothing. The button itself is always the retry.
  const [inviting, setInviting] = useState(false);
  const [inviteNotice, setInviteNotice] = useState<
    'minted' | 'mintFailed' | 'shareFailed' | null
  >(null);
  // The fresh-tap ask speaks the input device's own verb (the streak hint's coarse-pointer
  // test, the history-tap rule's own pattern).
  const coarse = useMemo(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches,
    [],
  );

  // The invite link is both "add me" and "come play" (#189): one line of copy, then the
  // URL. Delivery (native sheet -> clipboard + COPIED) is useShare's, like every result.
  //
  // **THE INVITE TAP IS THE TRIGGER (#216, user-decided 2026-08-24)** — and minting and
  // sharing are TWO EXPLICIT PHASES (PR-219 follow-up review). Turnstile plus /devices
  // can outlive the browser's transient user activation, and past it BOTH deliveries
  // reject — navigator.share by spec, the async clipboard on WebKit — so a first tap that
  // shared after its own mint could create the account and then deliver nothing, silently.
  // Instead the tokenless tap ONLY bootstraps and then asks for a fresh tap in so many
  // words; that second tap shares inside its own activation, exactly like every result
  // screen's. A delivery that still fails (insecure context, denied clipboard) is said
  // (`failedShare`) rather than swallowed.
  const invite = async () => {
    if (inviting) return;
    setInviteNotice(null);
    if (!identity) {
      // PHASE ONE — the deliberate act that creates the account. No share on this
      // activation, however fast the mint lands: one rule, no timing-dependent branch.
      setInviting(true);
      try {
        const request = await ensureRequestIdentity(null);
        // A cross-tab replacement landed mid-mint: the screen is already re-keying on the
        // adopted identity, and the fresh-tap ask below still leads to ITS link.
        if (request) setInviteNotice('minted');
      } catch {
        setInviteNotice('mintFailed');
      } finally {
        setInviting(false);
      }
      return;
    }
    // PHASE TWO — an identity in hand, a live activation: deliver, and say so if neither
    // channel could.
    const delivered = await share(
      `${t(lang, 'boardInviteText')}\n${window.location.origin}${pathForInvite(identity.accountId)}`,
    );
    if (!delivered) setInviteNotice('shareFailed');
  };

  return (
    <div className="board-screen">
      <TopBar
        lang={lang}
        left={<span className="topbar-title">{t(lang, 'boardTitle')}</span>}
        center={
          // The header's own tabs switch WHICH daily's board this is; the in-screen
          // tabs below switch whose scores are on it.
          <ModeTabs lang={lang} mode={mode} onSelect={(m) => navigate(pathForBoard(lang, m))} />
        }
        right={
          <button
            type="button"
            className="home-btn archive-close"
            aria-label={t(lang, 'ariaBackToToday')}
            onClick={() => navigate(pathForMode(lang, mode))}
          >
            <CloseIcon className="ui-icon" aria-hidden />
          </button>
        }
      />

      {/* The identity strip: the mark and name a board row shows for YOU, with the two
          things this screen wires in — the profile editor and the invite link. An
          uncustomized player reads as their pseudonym, in the secondary ink. */}
      <div className="board-me">
        {/* Until the read settles this is a SKELETON, never a name: publishing the
            assigned identity early and correcting it a beat later showed every named
            player a stranger's name under their own mark (user feedback 2026-08-20).
            The skeleton holds the exact layout the real strip takes, so nothing moves
            when it resolves. */}
        {me ? (
          <Avatar avatar={me.avatar ?? defaultAvatar(me.publicId)} size={40} />
        ) : (
          <span
            className={`board-me-slot${meSettled ? '' : ' skeleton'}`}
            aria-hidden="true"
          />
        )}
        {me ? (
          <span className={`board-me-name${me.name ? '' : ' anon'}`}>
            {me.name || anonName(me.publicId)}
          </span>
        ) : (
          <span className="board-me-name" aria-hidden="true">
            {!meSettled && <span className="skeleton skeleton-name" />}
          </span>
        )}
        {/* `/profile` is a GLOBAL route, so the board that opened it leaves the URL —
            state where to come back to, or the editor has to guess from the last
            loaded GAME (which can be the other daily, or another language). */}
        <button
          type="button"
          className="board-chip"
          onClick={() => {
            setProfileReturn(pathForBoard(lang, mode));
            navigate(PROFILE_PATH);
          }}
        >
          {t(lang, 'boardEdit')}
        </button>
      </div>

      {/* FRIENDS first — the trusted default; GLOBAL is the fun view. The segmented
          control is the header mode switcher's own dress, stretched to the column. */}
      <nav className="mode-tabs board-tabs" aria-label={t(lang, 'boardTitle')}>
        {(['friends', 'global'] as const).map((view) => (
          <button
            key={view}
            type="button"
            className={`mode-tab${tab === view ? ' active' : ''}`}
            aria-current={tab === view || undefined}
            onClick={() => setTab(view)}
          >
            {t(lang, view === 'friends' ? 'boardFriends' : 'boardGlobal')}
          </button>
        ))}
      </nav>

      <div className="board-body">
        {entry === 'failed' ? (
          <LoadError
            message={t(lang, 'failedBoard')}
            lang={lang}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        ) : board ? (
          <BoardList
            key={tab}
            board={board}
            tab={tab}
            lang={lang}
            mode={mode}
            meId={meId ?? undefined}
            // Only the GLOBAL list marks friends: on the friends board every row is one,
            // and marking everything marks nothing.
            friendIds={tab === 'global' ? friendIds : null}
          />
        ) : (
          <p className="status">
            <LoadingWave text={t(lang, 'loading')} />
          </p>
        )}
      </div>

      {/* The invite link's sending surface (#189): the screen's one big action — and the
          route's account-creating trigger (#216, user-decided 2026-08-24), so it is live
          for a brand-new visitor and holds a LoadingWave while its own mint is in flight
          (the Word gate's PLAY shape). The line above it carries the tap's outcome: the
          fresh-tap ask after a mint, or the loud failure whose retry is the button itself.
          The label swaps to COPIED on the clipboard path, the share button's own gesture. */}
      {inviteNotice === 'minted' && (
        <p className="status">{t(lang, coarse ? 'inviteReadyTap' : 'inviteReadyClick')}</p>
      )}
      {inviteNotice === 'mintFailed' && (
        <p className="status error">{t(lang, 'failedInviteLink')}</p>
      )}
      {inviteNotice === 'shareFailed' && (
        <p className="status error">{t(lang, 'failedShare')}</p>
      )}
      <button
        type="button"
        className="mix-btn board-invite"
        disabled={inviting}
        onClick={() => void invite()}
      >
        {inviting ? (
          <LoadingWave text={t(lang, 'loading')} />
        ) : copied ? (
          t(lang, 'copied')
        ) : (
          t(lang, 'boardInvite')
        )}
      </button>
    </div>
  );
}

function BoardList({
  board,
  tab,
  lang,
  mode,
  meId,
  friendIds,
}: {
  board: Board;
  tab: Tab;
  lang: LangCode;
  mode: Mode;
  meId?: string;
  friendIds: ReadonlySet<string> | null;
}) {
  // Empty is per TAB. The GLOBAL board is empty when nobody played. The FRIENDS board
  // is empty when the caller has NO EDGES: the server always includes the caller's own
  // row once they played, and a board of exactly yourself — under an identity strip
  // already wearing your name and mark — still means "no friends yet", which is what
  // the ghost says and the INVITE button below remedies (user-decided 2026-08-20; a
  // friend who merely has not played is a waiting row, never empty).
  const others = board.rows.filter((row) => row.publicId !== meId);
  const empty =
    (tab === 'friends' ? others.length === 0 : board.rows.length === 0) &&
    (board.own?.length ?? 0) === 0 &&
    board.waiting.length === 0;
  if (empty) {
    // A sad ghost over a terse line: an empty FRIENDS tab means no edges at all (the
    // merely-unplayed show as waiting rows), an empty GLOBAL one means nobody played.
    // The ghost is the user's own pixel art, masked so it tints like an icon (CSS).
    return (
      <div className="board-empty">
        <span className="board-ghost" aria-hidden="true" />
        <p>{t(lang, tab === 'friends' ? 'boardEmptyFriends' : 'boardEmptyGlobal')}</p>
      </div>
    );
  }
  let index = 0;
  const item = (row: BoardRow) => (
    <BoardRowItem
      key={row.publicId}
      row={row}
      me={row.publicId === meId}
      friend={friendIds?.has(row.publicId) ?? false}
      index={index++}
    />
  );
  return (
    <>
      {/* The unit column caption: which way is better is the mode's, and naming the
          unit is how the list says it (the score headline's own rule). Only over
          actual scores — a board of nothing but waiting friends has no score column
          to caption (user feedback 2026-08-20). */}
      {board.rows.length > 0 && (
        <div className="board-unit" aria-hidden="true">
          {t(lang, mode === 'word' ? 'words' : 'tries')}
        </div>
      )}
      <ol className="board-list pixel-scroll">
        {board.rows.map(item)}
        {board.own && board.own.length > 0 && (
          <>
            {/* The gap says "the line continues below the cut" in the app's own dashed
                vocabulary before the caller's own neighborhood. */}
            <li className="board-gap" aria-hidden="true" />
            {board.own.map(item)}
          </>
        )}
        {/* Friends with no score today (friends board only): named, never dropped.
            ONE section caption says why for all of them (user feedback 2026-08-20 —
            the per-row label read as a stutter); each row keeps the dashed "not yet"
            frame and a centered no-rank tick where its rank would be. */}
        {board.waiting.length > 0 && (
          <li className="board-section">{t(lang, 'boardNotPlayed')}</li>
        )}
        {board.waiting.map((player) => (
          <WaitingRowItem key={player.publicId} player={player} index={index++} />
        ))}
      </ol>
    </>
  );
}

function WaitingRowItem({ player, index }: { player: BoardPlayer; index: number }) {
  return (
    <li className="board-row waiting" style={{ '--i': index } as CSSProperties}>
      {/* No rank yet — a small centered tick where the number would be, so the cell
          never reads as a rendering hole. */}
      <span className="board-norank" aria-hidden="true" />
      <Avatar avatar={player.avatar ?? defaultAvatar(player.publicId)} size={28} />
      <span className={`board-name${player.name ? '' : ' anon'}`}>
        {player.name || anonName(player.publicId)}
      </span>
    </li>
  );
}

function BoardRowItem({
  row,
  me,
  friend,
  index,
}: {
  row: BoardRow;
  me: boolean;
  friend: boolean;
  index: number;
}) {
  return (
    <li
      // `me` wins over `friend`: your own row is never one of your edges, but a stale
      // list could say so, and two markers on one row is a rendering bug on screen.
      className={`board-row${me ? ' me' : friend ? ' friend' : ''}`}
      style={{ '--i': index } as CSSProperties}
      aria-current={me || undefined}
    >
      <span className="board-rank">#{row.rank}</span>
      <Avatar avatar={row.avatar ?? defaultAvatar(row.publicId)} size={28} />
      <span className={`board-name${row.name ? '' : ' anon'}`}>
        {row.name || anonName(row.publicId)}
      </span>
      <span className="board-score">{row.score}</span>
    </li>
  );
}
