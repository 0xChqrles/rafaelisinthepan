import { useEffect, useState, type CSSProperties } from 'react';
import {
  activeDate,
  publicIdFromSecret,
  type Board,
  type BoardPlayer,
  type BoardRow,
} from '@whippin/shared';
import { boardUrl, parseBoard, parseProfile, postBoardBody, profileUrl } from '../api';
import { anonName } from '../anonName';
import { defaultAvatar } from '../defaultAvatar';
import Avatar from '../components/Avatar';
import LoadError from '../components/LoadError';
import LoadingWave from '../components/LoadingWave';
import ModeTabs from '../components/ModeTabs';
import TopBar from '../components/TopBar';
import useShare from '../hooks/useShare';
import { playerSecret } from '../identity';
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
// own-row window — @whippin/shared's leaderboard rules);
// this screen only draws what the API returned. The own row wears the app's ONE
// emphasis gesture, the inverted selection box.
type Tab = 'friends' | 'global';

// What the "me" strip knows about the player: the derived publicId immediately, the
// stored profile once (and if) its read answers. Both degrade silently — the strip is
// identity chrome, not the board, so a failed profile read shows the id and the blank
// mark rather than an error.
interface Me {
  publicId: string;
  name: string;
  avatar: string | null;
}

export default function Leaderboard({ lang, mode }: { lang: LangCode; mode: Mode }) {
  const [tab, setTab] = useState<Tab>('friends');
  const [me, setMe] = useState<Me | null>(null);
  // ONE outcome slot per tab — a board, or that tab's own failure. Screen-global
  // failure state painted a FAILED frame over the other tab's perfectly good board for
  // a render when flipping back (review finding, 2026-08-20).
  const [boards, setBoards] = useState<Partial<Record<Tab, Board | 'failed'>>>({});
  const [attempt, setAttempt] = useState(0);
  // The pinned `share` analytics event means "a RESULT left the app" (the three-event
  // invariant); an invite link is not a result, so its delivery is untracked rather
  // than quietly redefining the metric.
  const { share, copied } = useShare({ tracked: false });

  // The identity strip: the id is derived locally (generated on first need, #187 — the
  // invite link's own rule, since sharing it IS this screen's job), the profile read
  // fills the name and the mark in when it lands. A 404 is "never customized".
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const publicId = await publicIdFromSecret(playerSecret());
        if (cancelled) return;
        setMe({ publicId, name: '', avatar: null });
        const response = await fetch(profileUrl(publicId));
        if (cancelled || !response.ok) return;
        const profile = parseProfile(await response.json());
        if (!cancelled) setMe({ publicId, name: profile.name, avatar: profile.avatar });
      } catch {
        // Silent: the strip already shows the id (or, pre-derivation, nothing).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // One fetch per tab ACTIVATION — the route is a zero-TTL live read, so a tab flip
  // re-reads rather than trusting a snapshot from minutes ago; the cached board holds
  // the screen while the fresh one is in flight (stale-but-good beats a spinner), and
  // RETRY refetches. FRIENDS is the authenticated POST — the server resolves YOUR
  // edges, so the read has to prove who is asking (#187: the secret in the body, never
  // a query string). GLOBAL is the anonymous GET, widened with the caller's own window
  // via their PUBLIC id.
  useEffect(() => {
    let cancelled = false;
    // A standing failure turns back into the loading state for this pass.
    setBoards((prev) => (prev[tab] === 'failed' ? { ...prev, [tab]: undefined } : prev));
    (async () => {
      try {
        const date = activeDate(new Date());
        const secret = playerSecret();
        // The global read needs NO identity — the caller's public id only widens it
        // with their own window, and deriving it can genuinely fail (crypto.subtle is
        // absent outside a secure context, e.g. the LAN-IP mobile check `board:seed`
        // exists to support). A failed derivation degrades to the plain anonymous
        // read; it must never kill a tab that needs no identity.
        let id: string | undefined;
        if (tab === 'global') {
          try {
            id = await publicIdFromSecret(secret);
          } catch {
            id = undefined;
          }
        }
        const response =
          tab === 'friends'
            ? await postBoardBody(boardUrl(lang, date, mode), { secret })
            : await fetch(boardUrl(lang, date, mode, id));
        if (cancelled) return;
        if (!response.ok) throw new Error(`board answered ${response.status}`);
        const board = parseBoard(await response.json());
        if (!cancelled) setBoards((prev) => ({ ...prev, [tab]: board }));
      } catch {
        // FAILED only when there is nothing to show: an error frame over rows already
        // on screen helps nobody — the cached board stands until a refresh succeeds.
        if (!cancelled) {
          setBoards((prev) =>
            prev[tab] && prev[tab] !== 'failed' ? prev : { ...prev, [tab]: 'failed' },
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, lang, mode, attempt]);

  const entry = boards[tab];
  const board = entry === 'failed' ? undefined : entry;

  // The invite link is both "add me" and "come play" (#189): one line of copy, then the
  // URL. Delivery (native sheet -> clipboard + COPIED) is useShare's, like every result.
  const invite = () => {
    if (!me) return;
    void share(`${t(lang, 'boardInviteText')}\n${window.location.origin}${pathForInvite(me.publicId)}`);
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
          uncustomized player reads as their id, dimmed: the blank the editor fills. */}
      <div className="board-me">
        {/* No drawn mark yet = the ASSIGNED one (defaultAvatar, deterministic from the
            id — user feedback 2026-08-20, replacing the dashed empty frame); an empty
            slot only holds the layout while the id derives. */}
        {me ? (
          <Avatar avatar={me.avatar ?? defaultAvatar(me.publicId)} size={40} />
        ) : (
          <span className="board-me-slot" aria-hidden="true" />
        )}
        <span className={`board-me-name${me?.name ? '' : ' anon'}`}>
          {me ? me.name || anonName(me.publicId) : ''}
        </span>
        <button
          type="button"
          className="board-chip"
          onClick={() => navigate(PROFILE_PATH)}
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
          <BoardList key={tab} board={board} tab={tab} lang={lang} mode={mode} meId={me?.publicId} />
        ) : (
          <p className="status">
            <LoadingWave text={t(lang, 'loading')} />
          </p>
        )}
      </div>

      {/* The invite link's sending surface (#189): the screen's one big action. The
          label swaps to COPIED on the clipboard path, the share button's own gesture. */}
      <button type="button" className="mix-btn board-invite" disabled={!me} onClick={invite}>
        {copied ? t(lang, 'copied') : t(lang, 'boardInvite')}
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
}: {
  board: Board;
  tab: Tab;
  lang: LangCode;
  mode: Mode;
  meId?: string;
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
    <BoardRowItem key={row.publicId} row={row} me={row.publicId === meId} index={index++} />
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

function BoardRowItem({ row, me, index }: { row: BoardRow; me: boolean; index: number }) {
  return (
    <li
      className={`board-row${me ? ' me' : ''}`}
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
