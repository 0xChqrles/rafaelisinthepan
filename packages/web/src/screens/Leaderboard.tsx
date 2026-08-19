import { useEffect, useState, type CSSProperties } from 'react';
import { activeDate, publicIdFromSecret, type Board, type BoardRow } from '@whippin/shared';
import { boardUrl, parseBoard, parseProfile, postBoardBody, profileUrl } from '../api';
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
// The rows come ranked from the server (competition ties, the top-50 cut with its
// straddling-tie collapse, the own-row window — @whippin/shared's leaderboard rules);
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
  const [boards, setBoards] = useState<Partial<Record<Tab, Board>>>({});
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const { share, copied } = useShare();

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

  // One fetch per tab, cached for the visit (both are zero-TTL live reads, so a tab
  // flip back shows what was already read rather than a second spinner; RETRY refetches).
  // FRIENDS is the authenticated POST — the server resolves YOUR edges, so the read has
  // to prove who is asking (#187: the secret in the body, never a query string). GLOBAL
  // is the anonymous GET, widened with the caller's own window via their PUBLIC id.
  useEffect(() => {
    if (boards[tab]) {
      setFailed(false);
      return;
    }
    let cancelled = false;
    setFailed(false);
    (async () => {
      try {
        const date = activeDate(new Date());
        const secret = playerSecret();
        const response =
          tab === 'friends'
            ? await postBoardBody(boardUrl(lang, date, mode), { secret })
            : await fetch(boardUrl(lang, date, mode, await publicIdFromSecret(secret)));
        if (cancelled) return;
        if (!response.ok) {
          setFailed(true);
          return;
        }
        const board = parseBoard(await response.json());
        if (!cancelled) setBoards((prev) => ({ ...prev, [tab]: board }));
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `boards` is deliberately not a dependency: the effect only ever ADDS the entry it
    // is keyed on, and re-running on its own write would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, lang, mode, attempt]);

  const board = boards[tab];

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
        {me?.avatar ? (
          <Avatar avatar={me.avatar} size={40} />
        ) : (
          // No mark yet: the rows' own dashed "not yet" frame — the blank EDIT fills.
          <span className="board-noface board-noface-lg" aria-hidden="true" />
        )}
        <span className={`board-me-name${me?.name ? '' : ' anon'}`}>
          {me ? me.name || me.publicId : ''}
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
        {failed ? (
          <LoadError
            message={t(lang, 'failedBoard')}
            lang={lang}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        ) : board ? (
          <BoardList key={tab} board={board} lang={lang} mode={mode} meId={me?.publicId} />
        ) : (
          <p className="status board-status">
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
  lang,
  mode,
  meId,
}: {
  board: Board;
  lang: LangCode;
  mode: Mode;
  meId?: string;
}) {
  const empty =
    board.rows.length === 0 && board.overflow === null && (board.own?.length ?? 0) === 0;
  if (empty) {
    return <p className="board-empty">{t(lang, 'boardEmpty')}</p>;
  }
  let index = 0;
  const item = (row: BoardRow) => (
    <BoardRowItem key={row.publicId} row={row} me={row.publicId === meId} index={index++} />
  );
  return (
    <>
      {/* The unit column caption: which way is better is the mode's, and naming the
          unit is how the list says it (the score headline's own rule). */}
      <div className="board-unit" aria-hidden="true">
        {t(lang, mode === 'word' ? 'words' : 'tries')}
      </div>
      <ol className="board-list pixel-scroll">
        {board.rows.map(item)}
        {board.overflow && (
          <li className="board-row board-overflow" style={{ '--i': index++ } as CSSProperties}>
            <span className="board-rank">#{board.overflow.rank}</span>
            <span className="board-tied">
              +{board.overflow.count} {t(lang, 'boardTied')}
            </span>
          </li>
        )}
        {board.own && board.own.length > 0 && (
          <>
            {/* The gap says "the line continues below the cut" in the app's own dashed
                vocabulary before the caller's own neighborhood. */}
            <li className="board-gap" aria-hidden="true" />
            {board.own.map(item)}
          </>
        )}
      </ol>
    </>
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
      {row.avatar !== null ? (
        <Avatar avatar={row.avatar} size={28} />
      ) : (
        // No profile yet: a dashed empty frame — the app's "not yet" mark.
        <span className="board-noface" aria-hidden="true" />
      )}
      <span className={`board-name${row.name ? '' : ' anon'}`}>{row.name || row.publicId}</span>
      <span className="board-score">{row.score}</span>
    </li>
  );
}
