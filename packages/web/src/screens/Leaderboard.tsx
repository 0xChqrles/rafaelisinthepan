import { useEffect, useState, type CSSProperties } from 'react';
import {
  anonName,
  dateForDayNumber,
  defaultAvatar,
  progressHeatColor,
  type Board,
  type BoardPlayer,
  type BoardRow,
  type PlayingRow,
} from '@whippin/shared';
import {
  boardUrl,
  friendsUrl,
  parseBoard,
  parseFriends,
  postBoardBody,
  postFriendsBody,
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
  useIdentityMintedHere,
} from '../identity';
import { adoptSignedOutVerdict } from '../state/signedOutVerdict';
import { prefetchTurnstileTokens } from '../turnstile';
import ErrorScreen from '../components/ErrorScreen';
import { useGameStore, type BoardTab } from '../state/gameStore';
import {
  pathForArchive,
  pathForBoard,
  pathForInvite,
  pathForMode,
  type LangCode,
  type Mode,
} from '../langs';
import { navigate } from '../routing';
import { t } from '../i18n';
// Inline SVG (vite-plugin-svgr): the control that closes the board back onto the game,
// painting with currentColor; the button's aria-label names it.

// The #190 leaderboard screen: the day's boards per (day, lang, mode), for the active
// day. FRIENDS is the DEFAULT and the trusted surface — the whole point of the design
// (#187's anti-cheat stance: trust comes from the graph, not the global list) — with
// the GLOBAL top 50 as the second tab, explicitly the fun/untrusted view. This screen
// is also where a player customizes their profile (#188 — the EDIT chip onto /profile)
// and shares their invite link (#189 — the INVITE button), neither of which requires
// having played, which is why the header icon reaches it before a first round.
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
// friends board is the ghost + INVITE without a request, and the global read stays
// genuinely anonymous. The deliberate act that mints is the INVITE tap — the one thing on
// this screen that cannot exist without an account — and every identity-reading effect
// keys on the live identity, so a mint (or a cross-tab adoption) populates the boards
// without a remount.
//
// **THE IDENTITY STRIP IS GONE (2026-08-30, with the header rework).** The board opened
// on the player's own mark and name as a row — the LOCAL PLACEHOLDER for a tokenless
// device — and since #204 that row was the one door to `/account`. The header's right
// group now ends in the player's own face (`AccountKey`, on every game surface), which is
// the same drawing, the same door, 40px above where the strip sat: two identical faces
// stacked at the top of one screen read as a rendering fault, not as emphasis. What the
// strip carried beyond the face — the name — is on the account screen one tap away and on
// the player's own row once they have played; its profile read (a duplicate of
// `useOwnFace`'s) went with it.
type Tab = BoardTab;

// The tokenless FRIENDS board: a device with no account holds no edges and no rows, so
// this is the KNOWN-EMPTY answer (#216), installed synchronously — at first render and at
// every identity-scope reset — so a tokenless visit never flashes a LOADING frame for a
// request nobody makes.
const EMPTY_FRIENDS_BOARD: Board = { rows: [], own: null, playing: [], waiting: [] };
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
  // Whether that identity was MINTED here or ADOPTED — the known-empty rule below turns on
  // it, and the transition alone cannot say.
  const mintedHere = useIdentityMintedHere();

  // The id alone, available as soon as the identity is: it is what the own-row marker
  // needs, which never waits on a profile. Pure derivation — state here would only ever
  // mirror the identity, one sync hazard for nothing.
  const meId = identity?.accountId ?? null;
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
    // A TOKENLESS tab whose own MINT lands keeps the known-empty friends board (user
    // feedback 2026-08-26: the INVITE tap's mint made the ghost blink into a loading
    // frame — the loading belongs on the button alone). A freshly minted account has no
    // edges by construction, so known-empty is a FACT there, not a stale guess; the fetch
    // below still fires and the stale-but-good rule swaps in the server's answer.
    //
    // **It must be a MINT, not merely an acquisition** (review finding): `identity.ts`'s
    // own rule is that every other null → identity publish is an ADOPTION of an account
    // that MAY ALREADY HOLD SERVER STATE — a sibling tab's account, a pending token
    // recovered from storage, a raced bootstrap another tab won. An accepted invite is the
    // reachable case: its tap mints AND links in one gesture, so a sibling tab adopting
    // that identity has friends the instant it arrives. Keeping known-empty there is a
    // guess, and a failed refresh would freeze it — the stale-but-good rule keeps a cached
    // board over a failure, so the account's real edges AND the retry UI would both be
    // suppressed behind a false ghost. Every OTHER scope change (an adoption, A → B,
    // A → signed out) keeps the PR-219 rule: drop everything to the new scope's own
    // synchronous answer.
    setBoards(
      cachedEpoch === null && identity && mintedHere
        ? { friends: EMPTY_FRIENDS_BOARD }
        : boardsFor(identity),
    );
    setFriendIds(null);
  }
  // The pinned `share` analytics event means "a RESULT left the app" (the three-event
  // invariant); an invite link is not a result, so its delivery is untracked rather
  // than quietly redefining the metric.
  const { share, copied } = useShare({ tracked: false });
  // The one challenge a tokenless INVITE tap will spend on its deploy, in hand before the
  // tap — the less the mint waits on, the more often the same gesture can still deliver.
  useEffect(() => {
    if (identity === null) prefetchTurnstileTokens(1);
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
          await adoptSignedOutVerdict(response, epoch);
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
          // The anonymous GLOBAL read carries no epoch and can sign nobody out.
          if (epoch !== null) await adoptSignedOutVerdict(response, epoch);
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

  // The INVITE tap's own state: its bootstrap in flight, and which failure the error
  // surface reports. The tap exists to deliver a link, and saying nothing leaves the
  // player tapping a button that appears to do nothing.
  const [inviting, setInviting] = useState(false);
  const [inviteFailed, setInviteFailed] = useState<'account' | 'share' | null>(null);

  // The invite link is both "add me" and "come play" (#189): one line of copy, then the
  // URL. Delivery (native sheet -> clipboard + COPIED) is useShare's, like every result.
  //
  // **THE INVITE TAP IS THE TRIGGER (#216), AND IT IS ONE TAP** (user-decided 2026-08-24,
  // superseding the two-phase mint-then-ask: "always a single tap"): a tokenless tap
  // bootstraps and then delivers in the same gesture. The physics the two-phase design
  // guarded against still exist — Turnstile + /devices can outlive the transient user
  // activation, and past it navigator.share rejects by spec and the async clipboard does
  // on WebKit — so `useShare.share` REPORTS delivery, and a share neither channel could
  // make raises the error surface (`failedShare`) instead of being swallowed: its TRY
  // AGAIN runs inside its own fresh activation, with the identity now in hand, which is
  // exactly the delivery the first tap could not make. Desktop and an already-deployed
  // account never hit that path — the common case stays one tap, one sheet.
  const invite = async () => {
    if (inviting) return;
    setInviteFailed(null);
    let held = identity;
    if (held === null) {
      // The deliberate act that creates the account (LoadingWave in the button, the Word
      // gate's PLAY shape; a failure created nothing and says so).
      setInviting(true);
      try {
        const request = await ensureRequestIdentity(null);
        // A cross-tab replacement landed mid-mint: the screen is already re-keying on the
        // adopted identity — share ITS link, the one the button now stands for.
        held = request?.identity ?? deviceIdentity();
        if (held === null) return;
      } catch {
        setInviteFailed('account');
        return;
      } finally {
        setInviting(false);
      }
    }
    const delivered = await share(
      `${t(lang, 'boardInviteText')}\n${window.location.origin}${pathForInvite(held.accountId)}`,
    );
    if (!delivered) setInviteFailed('share');
  };

  return (
    <div className="board-screen">
      {/* THE BOARD KEEPS THE PUZZLE'S TITLE and takes no title of its own (user-decided
          2026-08-30). A board is a view OF a daily — it is addressed by (day, lang, mode)
          like everything else — so naming the daily names this screen too, and the sheet
          behind it still switches which daily's board this is, exactly as the retired
          centre tabs did. What the screen IS gets said by the LIT crown instead of by a
          word, which is the group's whole grammar.

          The way OUT is any other key of the same, unmoving row — HOME above all
          (`HeaderKeys`, user-decided 2026-08-31 after a lit-crown-as-exit and then a ✕
          were each rejected: the first was not intuitive, the second rearranged the row). */}
      <HeaderLeft>
        <PuzzleTitle lang={lang} mode={mode} surface="board" />
      </HeaderLeft>

      {/* FRIENDS first — the trusted default; GLOBAL is the fun view. The segmented
          control is the header mode switcher's own dress, stretched to the column. */}
      <nav className="board-tabs" aria-label={t(lang, 'boardTitle')}>
        {(['friends', 'global'] as const).map((view) => (
          <button
            key={view}
            type="button"
            className={`board-tab${tab === view ? ' active' : ''}`}
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

      {/* The tap's failure, on the app's error surface (#216 rework): the deploy failing
          created nothing; a delivery failing has the account in hand, and TRY AGAIN
          shares inside its own fresh activation. */}
      {inviteFailed !== null && (
        <ErrorScreen
          lang={lang}
          title={t(lang, inviteFailed === 'account' ? 'failedAccount' : 'failedShare')}
          note={t(lang, inviteFailed === 'account' ? 'failedAccountNote' : 'failedShareNote')}
          onRetry={() => void invite()}
          onClose={() => setInviteFailed(null)}
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
  const playingOthers = board.playing.filter((row) => row.publicId !== meId);
  const empty =
    (tab === 'friends'
      ? others.length === 0 && playingOthers.length === 0
      : board.rows.length === 0) &&
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
          actual numbers — a board of nothing but waiting friends has no score column
          to caption (user feedback 2026-08-20); the in-progress rows' try counts sit
          in the same column, so they earn it too. */}
      {(board.rows.length > 0 || board.playing.length > 0) && (
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
        {/* Friends STILL PLAYING today (#206, friends board only), below every finished
            row: the live try count and reconstruction percentage, in the server's own
            order (`orderPlaying`), each with the no-rank tick — a mid-round position is
            never a rank claim. ONE section caption, the waiting group's rule. */}
        {board.playing.length > 0 && (
          <li className="board-section">{t(lang, 'boardPlaying')}</li>
        )}
        {board.playing.map((row) => (
          <PlayingRowItem key={row.publicId} row={row} me={row.publicId === meId} index={index++} />
        ))}
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

function PlayingRowItem({
  row,
  me,
  index,
}: {
  row: PlayingRow;
  me: boolean;
  index: number;
}) {
  return (
    <li
      className={`board-row playing${me ? ' me' : ''}`}
      // The row's heat is its progress read straight on the app's ONE ramp (heat.ts:
      // "every progress surface"), feeding the % ink. The ink ALONE carries it (user
      // feedback 2026-08-26, dropping the first cut's bottom filament: too much colour
      // pressed against the avatars, and it fattened the playing rows against their
      // ranked neighbors).
      style={{ '--i': index, '--play-heat': progressHeatColor(row.progress) } as CSSProperties}
      aria-current={me || undefined}
    >
      {/* No rank — the waiting rows' centered tick: an order is not a rank claim. */}
      <span className="board-norank" aria-hidden="true" />
      <Avatar avatar={row.avatar ?? defaultAvatar(row.publicId)} size={28} />
      <span className={`board-name${row.name ? '' : ' anon'}`}>
        {row.name || anonName(row.publicId)}
      </span>
      {/* The reconstruction % in the game's own progress dress — pixel face, heat-ramp
          ink — then the live try count under the unit caption's column. */}
      <span className="board-progress">{Math.round(row.progress)}%</span>
      <span className="board-score">{row.tries}</span>
    </li>
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
