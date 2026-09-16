import { Fragment, useCallback, useEffect, useState } from 'react';
import { activeDate, dayNumber as dayNumberOf } from '@whippin/shared';
import LoadingWave from './components/LoadingWave';
import usePuzzle from './hooks/usePuzzle';
import Account from './screens/Account';
import AccountEmail from './screens/AccountEmail';
import Profile from './screens/Profile';
import Privacy from './screens/Privacy';
import GroupInvite from './screens/GroupInvite';
import Archive from './screens/Archive';
import Leaderboard from './screens/Leaderboard';
import SignedOut from './screens/SignedOut';
import { useIdentityScopeRevision, useSignedOut } from './identity';
import Game from './screens/Game';
import TopBar, { HeaderLeft } from './components/TopBar';
import PuzzleTitle from './components/PuzzleTitle';
import HeaderKeys, { type HeaderPlace } from './components/HeaderKeys';
import DeviceFrame from './components/DeviceFrame';
import FocusBrackets from './components/FocusBrackets';
import LazyStreakDialog from './components/LazyStreakDialog';
import LoadError from './components/LoadError';
import NoPuzzle from './components/NoPuzzle';
import Invite from './tutorial/Invite';
import Learn from './tutorial/Learn';
import Lesson from './tutorial/Lesson';
import { PLAY_LEVEL } from './tutorial/levels';
import { useGameStore } from './state/gameStore';
import { track } from './analytics';
import { useLocation, navigate } from './routing';
import { parseRoute, pathForGame, pathForLesson, type LangCode, type Route } from './langs';
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

// The two things a game route can be showing. Named because App picks one and GameRoute
// renders it: the header's presence follows this, not the other way round. (The tutorial was
// a third until #269 gave it routes of its own — `/<lang>/learn`.)
type GameSurface = 'invite' | 'game';

export default function App() {
  const pathname = useLocation();
  // The client's active game day bounds the date deep-link range (a future date -> home),
  // so parsing gets it here (kept out of parseRoute so parsing stays pure/testable).
  const today = activeDate(new Date());
  const route = parseRoute(pathname, { activeDate: today });
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

  const onboarded = useGameStore((s) => s.onboarded);
  // Answering the onboarding question settles it for good, whichever way it is answered:
  // SKIP on the invitation, a lesson's PLAY (`Lesson`), or leaving a lesson by the header.
  const setOnboarded = useGameStore((s) => s.setOnboarded);

  // WHICH GAME-ROUTE SURFACE IS UP. It lives here because the header does (see `TopBar`):
  // the row is app chrome now, and whether a surface wears it is the router's question, not
  // the screen's. The onboarding INVITATION is the one game surface without the row — a
  // first visitor answers it before the app's places open up — and the two dev harnesses
  // bypass it, which is why their state is held here too.
  const gameSurface: GameSurface =
    !onboarded && streakPreview == null && errorPreview == null ? 'invite' : 'game';

  // The game IS the home: `/` (and any unknown path) redirects to a language — the LINK's
  // own `?lang=` if it carries one, else the persisted last-played one, else the browser's
  // (fr* -> /fr), else English. replaceState so `/` never lingers in history: back from the
  // game exits instead of bouncing through the redirect, and a deep link to /fr or /en never
  // redirects.
  useEffect(() => {
    if (route.view !== 'home') return;
    navigate(pathForGame(homeLang), { replace: true });
  }, [route.view, homeLang]);

  // The board's whose-scores tab belongs to a VISIT (user feedback 2026-08-20, narrowing
  // the first cut's standing preference). It has to survive the two things that remount
  // the screen WITHOUT ending the visit — a page refresh and a header language pick — so it
  // is persisted; and leaving the leaderboard is what ends it, so the next open is the
  // GROUP, the trusted default. Rendering a non-board route IS the leaving, which is
  // why the rule lives here: an entry point that forgot to reset would silently reopen on
  // a stale tab forever, and there is more than one way onto this screen.
  const resetBoardTab = useGameStore((s) => s.resetBoardTab);
  useEffect(() => {
    if (route.view !== 'board') resetBoardTab();
  }, [route.view, resetBoardTab]);

  // Keep <html lang> honest: index.html ships lang="en", but on /fr both the puzzle
  // content and the UI chrome are French — screen readers pick pronunciation rules from
  // this attribute. Every language-scoped route uses its own lang;
  // the language-less routes use the same resolution as the `/` redirect.
  const docLang = 'lang' in route ? route.lang : homeLang;
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

  const place = blocked ? null : headerPlace(route, gameSurface, today);
  // Leaving a lesson by the row IS skipping it: tracked as such, and the onboarding question
  // is settled so the invitation does not ask again (nothing is recorded as done).
  const leaveLesson = useCallback(() => {
    track('tutorial', { action: 'skip' });
    setOnboarded();
  }, [setOnboarded]);

  return (
    <div className="app">
      {/* The viewport's own furniture (decorative, desktop-only) — under every screen. */}
      <DeviceFrame serial={editionDay} />
      {/* The keyboard's focus, drawn once for every screen (#267). */}
      <FocusBrackets />
      <Fragment key={identityScope}>
        {/* THE HEADER, MOUNTED ONCE — it outlives the screens under it, which is what keeps
            the player's own face from re-reading its profile on every tap (`TopBar`). The
            screens publish only their left slot, through `HeaderLeft`. */}
        {place !== null && (
          <TopBar
            right={
              <HeaderKeys
                // The row's own language: the route's where it names one, the resolved home
                // language everywhere else — the same split `docLang` makes above.
                lang={docLang}
                on={place}
                litLeads={
                  (place === 'archive' && route.view === 'game') || route.view === 'lesson'
                }
                leave={route.view === 'lesson' ? leaveLesson : undefined}
              />
            }
          />
        )}
        {/* The living backdrop — every screen (game, archive, tutorial) sits on it. */}
        {blocked && <SignedOut lang={homeLang} />}
        {/* The ACCOUNT area (#204's UX rework): three routes, three questions — the
            account itself, the editor, and the email flow. One purpose per screen. */}
        {!blocked && route.view === 'account' && <Account />}
        {!blocked && route.view === 'accountEmail' && <AccountEmail intent={route.intent} />}
        {!blocked && route.view === 'profile' && <Profile />}
        {/* The data notice (#229) — a STEP of the account area, reachable on its own URL
            because a legal notice has to be linkable (the SES review opens one), and the
            one route a sign-out does not close (`blocked`): it reads no private state. */}
        {!blocked && route.view === 'privacy' && <Privacy />}
        {/* The group invite landing (#271) is a beat, not a screen: it records the
            membership and hands over to the game or the group's board. */}
        {!blocked && route.view === 'groupInvite' && (
          <GroupInvite groupId={route.groupId} lang={homeLang} />
        )}
        {!blocked && route.view === 'archive' && <Archive lang={route.lang} />}
        {/* The tutorial (#269): the list of levels, and one level's lesson on its own route. */}
        {!blocked && route.view === 'learn' && <Learn lang={route.lang} />}
        {!blocked && route.view === 'lesson' && <Lesson lang={route.lang} level={route.level} />}
        {/* The leaderboard screen (#190) — keyed so switching language drops the cached
            reads for that board's own. The TAB is deliberately outside the key: a language
            pick is still the same visit (see the reset effect above). */}
        {!blocked && route.view === 'board' && <Leaderboard key={route.lang} lang={route.lang} />}
        {!blocked && route.view === 'game' && (
          <GameRoute
            lang={route.lang}
            date={route.date}
            surface={gameSurface}
            settleOnboarding={setOnboarded}
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
      // Any OTHER day is the ARCHIVE's — tomorrow's sentence included (#273, user-decided
      // 2026-09-11 on the second pass: it "should actually live as an archive play, so you
      // can just click the house to go back"). HOME unlit is a live key, which is the way
      // back before the night's lock; the locked round's own TODAY button is the way back
      // after it.
      return route.date == null || route.date === today ? 'home' : 'archive';
    case 'archive':
      return 'archive';
    case 'board':
      return 'board';
    // The tutorial is the RULES' place — its list of levels and a lesson alike (#269).
    case 'learn':
    case 'lesson':
      return 'rules';
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

// One puzzle route: /<lang> plays today's sentence and /<lang>/<date> replays a past
// archive day (#55) — or tomorrow's (#273). Loads the day's puzzle for the language and
// records it as the last-played language. What the route puts in the header's left slot is
// identical through loading, error, missing-puzzle and the loaded game, so the header stays
// put while the body swaps.
function GameRoute({
  lang,
  date,
  // WHICH surface is App's call, because the header is (see `headerPlace`); rendering it is
  // this route's, because the puzzle and the callbacks live here.
  surface,
  settleOnboarding,
  preview,
}: {
  lang: LangCode;
  date?: string;
  surface: GameSurface;
  settleOnboarding: () => void;
  preview: {
    streak: number | null;
    dismissStreak: () => void;
    error: ErrorVariantName | null;
    cycleError: () => void;
  };
}) {
  const { puzzle, dayNumber, error, loading, noPuzzle, retry } = usePuzzle(lang, date);
  const setLastLang = useGameStore((s) => s.setLastLang);

  // A dated route replays a past day when its date is not today's active game day; the
  // undated route is always the active day. Gates the streak celebration + solve analytics.
  // LIVE, off the app's one day signal (#273): a dated route can also be TOMORROW's
  // sentence, started tonight, and a tab held open across the 22:00 flip has to see it
  // become the active day — the lock lifts, the streak read starts — without a reload.
  const today = useToday();
  const isActiveDay = date == null || dayNumberOf(date) === today;
  const early = date != null && dayNumberOf(date) > today;

  // Visiting a puzzle route makes this the last-played language (seeds the `/` redirect).
  useEffect(() => {
    setLastLang(lang);
  }, [lang, setLastLang]);

  // Onboarding (#51, #269): the tutorial NEVER starts without an action. A first visit (no
  // persisted `onboarded`) lands on the INVITATION — standing in for the loading screen while
  // the day's puzzle fetches behind it. TUTORIAL opens level 1 on its own route (the lesson's
  // PLAY, or leaving it by the header, settles the question); SKIP settles it here. The
  // header's book is the way back, to the list of levels.
  if (surface === 'invite') {
    return (
      <Invite
        lang={lang}
        onAccept={() => {
          track('tutorial', { action: 'start' });
          navigate(pathForLesson(lang, PLAY_LEVEL));
        }}
        onSkip={() => {
          track('tutorial', { action: 'skip' });
          settleOnboarding();
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
        <PuzzleTitle lang={lang} dayNumber={isActiveDay ? null : dayNumber} />
      </HeaderLeft>
      {loading && (
        <p className="status">
          <LoadingWave text={t(lang, 'loading')} />
        </p>
      )}
      {error !== null && <LoadError message={t(lang, 'failedPuzzle')} lang={lang} onRetry={retry} />}
      {/* `date` tells NoPuzzle whether this is an archive miss. */}
      {noPuzzle && <NoPuzzle lang={lang} date={date} />}
      {puzzle && (
        <Game
          puzzle={puzzle}
          dayNumber={dayNumber}
          isActiveDay={isActiveDay}
          early={early}
          deferResultsAnimation={preview.streak != null}
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
