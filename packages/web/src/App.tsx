import { Fragment, useCallback, useEffect, useState } from 'react';
import { activeDate } from '@whippin/shared';
import LoadingWave from './components/LoadingWave';
import usePuzzle from './hooks/usePuzzle';
import useWordPuzzle from './hooks/useWordPuzzle';
import LanguageSelect from './screens/LanguageSelect';
import Account from './screens/Account';
import AccountEmail from './screens/AccountEmail';
import Profile from './screens/Profile';
import Privacy from './screens/Privacy';
import FriendInvite from './screens/FriendInvite';
import Archive from './screens/Archive';
import Leaderboard from './screens/Leaderboard';
import SignedOut from './screens/SignedOut';
import { useIdentityScopeRevision, useSignedOut } from './identity';
import Game from './screens/Game';
import WordGame from './screens/WordGame';
import TopBar, { HeaderLeft } from './components/TopBar';
import PuzzleTitle from './components/PuzzleTitle';
import HeaderKeys, { type HeaderPlace } from './components/HeaderKeys';
import DeviceFrame from './components/DeviceFrame';
import LazyStreakDialog from './components/LazyStreakDialog';
import LoadError from './components/LoadError';
import NoPuzzle from './components/NoPuzzle';
import LazyTutorial from './tutorial/LazyTutorial';
import Invite from './tutorial/Invite';
import { useGameStore } from './state/gameStore';
import { track } from './analytics';
import { useLocation, navigate } from './routing';
import {
  parseRoute,
  pathForMode,
  pathForArchive,
  pathForBoard,
  type LangCode,
  type Mode,
  type Route,
} from './langs';
// Inline SVG (vite-plugin-svgr): the header's leaderboard entry, painting with
// currentColor like every chrome icon; the button's aria-label names it.
import { t } from './i18n';
import useToday from './hooks/useToday';
import useUiLang from './hooks/useUiLang';
import { streakPreviewFromSearch } from './dev/streakPreview';
import ErrorScreen from './components/ErrorScreen';
import {
  nextErrorVariant,
  errorPreviewFromSearch,
  errorVariant,
  type ErrorVariantName,
} from './dev/errorPreview';

// The three things a game route can be showing. Named because App picks one and GameRoute
// renders it: the header's presence follows this, not the other way round.
type GameSurface = 'tutorial' | 'invite' | 'game';

export default function App() {
  const pathname = useLocation();
  // The client's active game day bounds the date deep-link range (a future date -> home),
  // so parsing gets it here (kept out of parseRoute so parsing stays pure/testable).
  const today = activeDate(new Date());
  const route = parseRoute(pathname, { activeDate: today });
  const lastMode = useGameStore((s) => s.lastMode);
  // The chrome language of every screen the URL does not name one for — the link's `?lang=`,
  // then the stored preference, then the browser's (`hooks/useUiLang`).
  const homeLang = useUiLang();

  // Dev-only animation harness: the value is the PREVIOUS streak, so ?streak=9 previews
  // 9 -> 10 immediately without mutating persisted rounds or solved-day history.
  const [streakPreview, setStreakPreview] = useState<number | null>(() =>
    streakPreviewFromSearch(window.location.search),
  );
  // Stable across renders: StreakDialog keys its whole staged sequence on onDismiss, so
  // an inline closure would restart the animation every time the game route re-renders.
  const dismissStreakPreview = useCallback(() => setStreakPreview(null), []);
  // Dev-only preview of the error surface (`?error=<variant>`): the real ErrorScreen over
  // whatever route is on screen, so the box is judged against a real backdrop. Closing
  // CYCLES the copy set rather than dismissing — see dev/errorPreview.ts.
  const [errorPreview, setErrorPreview] = useState<ErrorVariantName | null>(() =>
    errorPreviewFromSearch(window.location.search),
  );
  const cycleErrorPreview = useCallback(
    () => setErrorPreview((held) => (held === null ? null : nextErrorVariant(held))),
    [],
  );

  // The dev force-flag (`?tutorial=1`) opens the lesson before the first paint. It sits
  // ABOVE the subscription below so the first render already sees it open — the store write
  // is this component's own, and a write from the game route would now be a child updating
  // its parent mid-render.
  useState(() => {
    const forced = new URLSearchParams(window.location.search).get('tutorial') === '1';
    const store = useGameStore.getState();
    if (forced && !store.tutorialOpen) store.openTutorial('first');
    return null;
  });
  const onboarded = useGameStore((s) => s.onboarded);
  const tutorialOpen = useGameStore((s) => s.tutorialOpen);
  const setOnboarded = useGameStore((s) => s.setOnboarded);
  // Answering the onboarding question settles it for good, whichever way it is answered.
  // Owned here because the header's own tutorial key leaves the lesson with it, and two
  // spellings of "close the tutorial" would be one flag apart.
  const closeTutorial = useCallback(() => {
    setOnboarded();
    useGameStore.getState().closeTutorial();
  }, [setOnboarded]);

  // WHICH GAME-ROUTE SURFACE IS UP. It lives here because the header does (see `TopBar`):
  // the row is app chrome now, and whether a surface wears it is the router's question, not
  // the screen's. The onboarding INVITATION is the one game surface without the row — a
  // first visitor answers it before the app's places open up — and the two dev harnesses
  // bypass it, which is why their state is held here too.
  const gameSurface: GameSurface = tutorialOpen
    ? 'tutorial'
    : !onboarded && streakPreview == null && errorPreview == null
      ? 'invite'
      : 'game';

  // The game IS the home: `/` (and any unknown path) redirects to a language — the LINK's
  // own `?lang=` if it carries one, else the persisted last-played one, else the browser's
  // (fr* -> /fr), else English — in the LAST-PLAYED MODE (#156: arrival lands on it, like
  // the language; a first visit has no preference and lands on the sentence). replaceState
  // so `/` never lingers in history: back from the game exits instead of bouncing through
  // the redirect, and a deep link to /fr or /en never redirects.
  useEffect(() => {
    if (route.view !== 'home') return;
    navigate(pathForMode(homeLang, lastMode ?? 'sentence'), { replace: true });
  }, [route.view, homeLang, lastMode]);

  // The board's whose-scores tab belongs to a VISIT (user feedback 2026-08-20, narrowing
  // the first cut's standing preference). It has to survive the two things that remount
  // the screen WITHOUT ending the visit — a page refresh and a header mode switch — so it
  // is persisted; and leaving the leaderboard is what ends it, so the next open is
  // FRIENDS, the trusted default. Rendering a non-board route IS the leaving, which is
  // why the rule lives here: an entry point that forgot to reset would silently reopen on
  // a stale tab forever, and there is more than one way onto this screen.
  const resetBoardTab = useGameStore((s) => s.resetBoardTab);
  useEffect(() => {
    if (route.view !== 'board') resetBoardTab();
  }, [route.view, resetBoardTab]);

  // Keep <html lang> honest: index.html ships lang="en", but on /fr both the puzzle
  // content and the UI chrome are French — screen readers pick pronunciation rules from
  // this attribute. Language-scoped routes (game + archive + board) use their own lang;
  // the language-less routes use the same resolution as the `/` redirect.
  const docLang =
    route.view === 'game' || route.view === 'archive' || route.view === 'board'
      ? route.lang
      : homeLang;
  useEffect(() => {
    document.documentElement.lang = docLang;
  }, [docLang]);

  // The frame's edition serial is the ACTIVE day's own index — today's number whatever
  // screen is up (an archived day's date already reads in the header's date chip).
  const editionDay = useToday();

  // Signed out from another device (#216). It takes the whole screen because it is not one
  // surface's problem: every private read on every route answers `unknown_device` from here
  // on, so there is nothing under it worth rendering, and a player who reads a vanished
  // streak as a bug is exactly what the copy exists to prevent.
  const signedOut = useSignedOut();
  // **EXCEPT THE NOTICE (#229).** It reads no private state and makes no request: it is a
  // document about what the game stores, and the one screen here that has to be LINKABLE.
  // A verdict that swallowed it would answer "what do you keep about me?" with a sign-in
  // screen — for the one player who has the strongest reason to ask, and for anyone opening
  // the URL on a device that was signed out from elsewhere.
  const blocked = signedOut && route.view !== 'privacy';
  // Component-local caches (profile fields, board rows, device lists, invite outcomes)
  // belong to the identity that mounted them. A scope change remounts the whole routed
  // surface synchronously, including when a replacement arrives after an intervening null;
  // DeviceFrame is decorative and deliberately remains outside.
  const identityScope = useIdentityScopeRevision();

  // The row's own language and daily: the route's where it names one, the resolved home
  // pair everywhere else — the same split `docLang` makes just above.
  const routed = route.view === 'game' || route.view === 'archive' || route.view === 'board';
  const place = blocked ? null : headerPlace(route, gameSurface, today);
  // Leaving the lesson by the row IS skipping it, so the row says so before it goes.
  const leaveTutorial = useCallback(() => {
    track('tutorial', { action: 'skip' });
    closeTutorial();
  }, [closeTutorial]);

  return (
    <div className="app">
      {/* The viewport's own furniture (decorative, desktop-only) — under every screen. */}
      <DeviceFrame serial={editionDay} />
      <Fragment key={identityScope}>
        {/* THE HEADER, MOUNTED ONCE — it outlives the screens under it, which is what keeps
            the player's own face from re-reading its profile on every tap (`TopBar`). The
            screens publish only their left slot, through `HeaderLeft`. */}
        {place !== null && (
          <TopBar
            right={
              <HeaderKeys
                lang={routed ? route.lang : homeLang}
                mode={routed ? route.mode : (lastMode ?? 'sentence')}
                on={place}
                leave={place === 'rules' ? leaveTutorial : undefined}
              />
            }
          />
        )}
        {/* The living backdrop — every screen (game, archive, select, tutorial) sits on it. */}
        {blocked && <SignedOut lang={homeLang} />}
        {!blocked && route.view === 'select' && <LanguageSelect />}
        {/* The ACCOUNT area (#204's UX rework): three routes, three questions — the
            account itself, the editor, and the email flow. One purpose per screen. */}
        {!blocked && route.view === 'account' && <Account />}
        {!blocked && route.view === 'accountEmail' && <AccountEmail intent={route.intent} />}
        {!blocked && route.view === 'profile' && <Profile />}
        {/* The data notice (#229) — a STEP of the account area, reachable on its own URL
            because a legal notice has to be linkable (the SES review opens one), and the
            one route a sign-out does not close (`blocked`): it reads no private state. */}
        {!blocked && route.view === 'privacy' && <Privacy />}
        {/* The invite link (#189) is a beat, not a screen: it lands the mutual edge and
            hands over to the home redirect above. */}
        {!blocked && route.view === 'invite' && (
          <FriendInvite publicId={route.publicId} lang={homeLang} />
        )}
        {!blocked && route.view === 'archive' && <Archive lang={route.lang} mode={route.mode} />}
        {/* The leaderboard screen (#190) — keyed so switching daily/language drops the
            cached reads for that board's own. The TAB is deliberately outside the key: a
            mode switch is still the same visit (see the reset effect above). */}
        {!blocked && route.view === 'board' && (
          <Leaderboard key={`${route.lang}:${route.mode}`} lang={route.lang} mode={route.mode} />
        )}
        {!blocked && route.view === 'game' && (
          <GameRoute
            lang={route.lang}
            mode={route.mode}
            date={route.date}
            surface={gameSurface}
            closeTutorial={closeTutorial}
            preview={{
              streak: streakPreview,
              dismissStreak: dismissStreakPreview,
              error: errorPreview,
              cycleError: cycleErrorPreview,
            }}
          />
        )}
        {/* home: redirecting on the next tick — render nothing. */}
      </Fragment>
    </div>
  );
}

// WHICH PLACE THE ROW LIGHTS, and `null` where the app wears no header at all: the language
// chooser, the invite landing, the onboarding question and the signed-out screen are each a
// surface with nowhere else to be.
function headerPlace(route: Route, surface: GameSurface, today: string): HeaderPlace | null {
  switch (route.view) {
    case 'game':
      if (surface === 'invite') return null;
      // The tutorial is the RULES' place; a past day is the ARCHIVE's.
      if (surface === 'tutorial') return 'rules';
      return route.date == null || route.date === today ? 'home' : 'archive';
    case 'archive':
      return 'archive';
    case 'board':
      return 'board';
    // The whole account area is ONE place, its steps included (#204's UX rework) —
    // the privacy notice among them (#229), reached from this area and no other.
    case 'account':
    case 'accountEmail':
    case 'profile':
    case 'privacy':
      return 'account';
    default:
      return null;
  }
}

// One puzzle route: /<lang> plays today's sentence, /<lang>/<date> replays a past
// archive day (#55), and /<lang>/word[/<date>] is Word mode's daily (#156) — one route
// component for both faces, so the header, the tutorial gate and the transient states
// (loading / error / missing-puzzle) cannot drift between them. Loads the day's
// artifact for the language and records it as the last-played language AND mode. The
// header (TopBar) is owned HERE — above every transient state and the loaded game alike.
// A loaded screen only reports the live content for its left slot, so the header itself
// stays put while the body swaps.
function GameRoute({
  lang,
  mode,
  date,
  // WHICH surface is App's call, because the header is (see `headerPlace`); rendering it is
  // this route's, because the puzzle and the callbacks live here.
  surface,
  closeTutorial,
  preview,
}: {
  lang: LangCode;
  mode: Mode;
  date?: string;
  surface: GameSurface;
  closeTutorial: () => void;
  preview: {
    streak: number | null;
    dismissStreak: () => void;
    error: ErrorVariantName | null;
    cycleError: () => void;
  };
}) {
  // ONE of the two hooks fetches (the other idles on a null lang): the two dailies are
  // separate artifacts behind separate URLs, and this route plays exactly one of them.
  const sentence = usePuzzle(mode === 'sentence' ? lang : null, date);
  const word = useWordPuzzle(mode === 'word' ? lang : null, date);
  const { dayNumber, error, loading, noPuzzle, retry } =
    mode === 'word' ? word : sentence;
  const setLastLang = useGameStore((s) => s.setLastLang);
  const setLastMode = useGameStore((s) => s.setLastMode);
  const setOnboarded = useGameStore((s) => s.setOnboarded);

  // A dated route replays a past day when its date is not today's active game day; the
  // undated route is always the active day. Gates the streak celebration + solve analytics.
  const isActiveDay = date == null || date === activeDate(new Date());

  // Visiting a puzzle route makes this the last-played language (seeds the `/` redirect).
  useEffect(() => {
    setLastLang(lang);
  }, [lang, setLastLang]);

  // The MODE is only remembered once the day's artifact has actually LOADED (#156). It
  // decides where `/` lands, and unlike a language a mode can be genuinely absent — word
  // artifacts are published per day and past days are not backfilled, so a day without one
  // is a plain 404. Recorded on arrival instead, a single tap on the header toggle on such
  // a day would pin every later visit to a route that shows NO PUZZLE TODAY and nothing
  // else, with only the toggle to escape it: arrival lands where you last PLAYED, and a
  // 404 is not play.
  const loaded = (mode === 'word' ? word.puzzle : sentence.puzzle) != null;
  useEffect(() => {
    if (loaded) setLastMode(mode);
  }, [loaded, mode, setLastMode]);

  // Onboarding tutorial (#51): it NEVER starts without an action. A first visit (no
  // persisted `onboarded`) lands on the INVITATION — standing in for the loading
  // screen while the day's puzzle fetches behind it — and TUTORIAL / SKIP both settle
  // the question for good (either sets the flag). The header's book re-opens the tutorial
  // as a `replay`; leaving the lesson by any other key skips it.
  // The open-tutorial state lives in the STORE (transient) so the tutorial's flag can
  // round-trip through the /select screen — this route unmounts, and picking a
  // language re-mounts it with the tutorial still open, now in that language.
  // The tutorial is MODE-AGNOSTIC on purpose: it teaches the rank mechanic both dailies
  // share, and its routes ending is Word mode's primer (#155/#156).
  const openTutorial = useGameStore((s) => s.openTutorial);

  // key={lang}: switching language mid-tutorial (via /select) restarts it in that
  // language.
  if (surface === 'tutorial') {
    return <LazyTutorial key={lang} lang={lang} mode={mode} onDone={closeTutorial} />;
  }
  if (surface === 'invite') {
    return (
      <Invite
        lang={lang}
        onAccept={() => {
          track('tutorial', { action: 'start' });
          openTutorial('first');
        }}
        onSkip={() => {
          track('tutorial', { action: 'skip' });
          closeTutorial();
        }}
      />
    );
  }

  return (
    <>
      {/* WHICH PUZZLE, into the header's left slot — identical through loading, error,
          missing-puzzle and the loaded game: which puzzle is a fact of the ROUTE, so it
          never waits on a game to report it. */}
      <HeaderLeft>
        <PuzzleTitle lang={lang} mode={mode} dayNumber={isActiveDay ? null : dayNumber} />
      </HeaderLeft>
      {loading && (
        <p className="status">
          <LoadingWave text={t(lang, 'loading')} />
        </p>
      )}
      {error !== null && <LoadError message={t(lang, 'failedPuzzle')} lang={lang} onRetry={retry} />}
      {/* `date` tells NoPuzzle whether this is an archive miss; `mode` keeps its return
          route on the same daily game's calendar. */}
      {noPuzzle && <NoPuzzle lang={lang} mode={mode} date={date} />}
      {mode === 'sentence' && sentence.puzzle && (
        <Game
          puzzle={sentence.puzzle}
          dayNumber={dayNumber}
          isActiveDay={isActiveDay}
          deferResultsAnimation={preview.streak != null}
        />
      )}
      {mode === 'word' && word.puzzle && (
        <WordGame
          puzzle={word.puzzle}
          dayNumber={dayNumber}
        />
      )}
      {preview.error != null && (
        <ErrorScreen
          key={preview.error}
          lang={lang}
          title={t(lang, errorVariant(preview.error).title)}
          note={t(lang, errorVariant(preview.error).note)}
          onClose={preview.cycleError}
        />
      )}
      {preview.streak != null && (
        <LazyStreakDialog
          lang={lang}
          solvedDay={dayNumber}
          previewPreviousStreak={preview.streak}
          onDismiss={preview.dismissStreak}
        />
      )}
    </>
  );
}
