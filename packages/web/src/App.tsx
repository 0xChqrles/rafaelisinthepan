import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  activeDate,
  dayNumber as dayNumberOf,
  isBonusRef,
  puzzleAddress,
  roundEnded,
  type Puzzle,
} from '@whippin/shared';
import GameHold, { useHold, type HoldTray } from './components/GameHold';
import usePuzzle from './hooks/usePuzzle';
import useVocab, { type Vocab } from './hooks/useVocab';
import useRoundSync from './hooks/useRoundSync';
import { retryRoundSync } from './state/roundSync';
import { roundOnScreen, type RoundOnScreen } from './game/roundOnScreen';
import { freshHolesFor, replayHoles } from './game/scoring';
import { playLogFor } from './game/playLog';
import Account from './screens/Account';
import AccountEmail from './screens/AccountEmail';
import Profile from './screens/Profile';
import Privacy from './screens/Privacy';
import GroupInvite from './screens/GroupInvite';
import Archive from './screens/Archive';
import Leaderboard from './screens/Leaderboard';
import SignedOut from './screens/SignedOut';
import { useDeviceIdentity, useIdentityScopeRevision, useSignedOut } from './identity';
import Game from './screens/Game';
import TopBar, { HeaderLeft } from './components/TopBar';
import PuzzleTitle from './components/PuzzleTitle';
import HeaderKeys, { type HeaderPlace } from './components/HeaderKeys';
import DeviceFrame from './components/DeviceFrame';
import FocusBrackets from './components/FocusBrackets';
import LazyStreakDialog from './components/LazyStreakDialog';
import NoPuzzle from './components/NoPuzzle';
import QuietFailure from './components/QuietFailure';
import Invite from './tutorial/Invite';
import Learn from './tutorial/Learn';
import Lesson from './tutorial/Lesson';
import { PLAY_LEVEL } from './tutorial/levels';
import { roundKeyFor, useGameStore, type RoundServer } from './state/gameStore';
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

// What the game route's round is drawn from (`game/roundOnScreen.ts`).
type Shown = RoundOnScreen<Puzzle, Vocab, RoundServer>;

export default function App() {
  const pathname = useLocation();
  const [lessonReturn, setLessonReturn] = useState<string | undefined>();
  const startOnboardingLesson = useCallback((lang: LangCode) => {
    setLessonReturn(pathname);
    track('tutorial', { action: 'start' });
    navigate(pathForLesson(lang, PLAY_LEVEL));
  }, [pathname]);
  // The client's active game day bounds the date deep-link range (a future date -> home),
  // so parsing gets it here (kept out of parseRoute so parsing stays pure/testable).
  const today = activeDate(new Date());
  const route = parseRoute(pathname, { activeDate: today });
  useEffect(() => {
    if (route.view !== 'lesson') setLessonReturn(undefined);
  }, [route.view]);
  // The chrome language of every screen the URL does not name one for — the link's `?lang=`,
  // then the stored preference, then the browser's (`hooks/useUiLang`).
  const homeLang = useUiLang();

  // Dev-only animation harness: the value is the PREVIOUS streak, so ?streak=9 previews
  // 9 -> 10 immediately without mutating persisted rounds or solved-day history.
  const [streakPreview, setStreakPreview] = useState<number | null>(() =>
    streakPreviewFromSearch(window.location.search),
  );
  // Stable across renders: StreakDialog's open effect depends on onDismiss, so an inline
  // closure would close and reopen the modal every time the game route re-renders.
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
  // Leaving the PLAYED lesson (level 1) by the row IS skipping it: tracked as such, and the
  // onboarding question is settled so the invitation does not ask again (nothing is recorded
  // as done). Leaving an article level is only leaving: it was never the onboarding.
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
                leave={route.view === 'lesson' && route.level === PLAY_LEVEL ? leaveLesson : undefined}
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
        {/* Keyed by language: each language has its own first day (#317), so switching
            language remounts the calendar on a month its range holds. */}
        {!blocked && route.view === 'archive' && <Archive key={route.lang} lang={route.lang} />}
        {/* The tutorial (#269): the list of levels, and one level's lesson on its own route. */}
        {!blocked && route.view === 'learn' && <Learn lang={route.lang} />}
        {!blocked && route.view === 'lesson' && (
          <Lesson lang={route.lang} level={route.level} returnTo={lessonReturn} />
        )}
        {/* The leaderboard screen (#190) — keyed so switching language drops the cached
            reads for that board's own. The TAB is deliberately outside the key: a language
            pick is still the same visit (see the reset effect above). */}
        {!blocked && route.view === 'board' && <Leaderboard key={route.lang} lang={route.lang} />}
        {!blocked && route.view === 'game' && (
          <GameRoute
            lang={route.lang}
            date={route.date}
            bonusId={route.bonusId}
            surface={gameSurface}
            settleOnboarding={setOnboarded}
            startLesson={startOnboardingLesson}
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
      // Any OTHER day is the ARCHIVE's; HOME unlit is a live key, the way back to today.
      // A BONUS puzzle is played like an archive day (bonus puzzles, 2026-09-24).
      if (route.bonusId !== undefined) return 'archive';
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
// archive day (#55). Loads the day's puzzle for the language and records it as the
// last-played language. What the route puts in the header's left slot is identical through
// loading, error, missing-puzzle and the loaded game, so the header stays put while the
// body swaps.
function GameRoute({
  lang,
  date,
  // A BONUS puzzle (shared bonus.ts), in place of a day: no date, never the active day —
  // played like an archive day, credited nothing.
  bonusId,
  // WHICH surface is App's call, because the header is (see `headerPlace`); rendering it is
  // this route's, because the puzzle and the callbacks live here.
  surface,
  settleOnboarding,
  startLesson,
  preview,
}: {
  lang: LangCode;
  date?: string;
  bonusId?: number;
  surface: GameSurface;
  settleOnboarding: () => void;
  startLesson: (lang: LangCode) => void;
  preview: {
    streak: number | null;
    dismissStreak: () => void;
    error: ErrorVariantName | null;
    cycleError: () => void;
  };
}) {
  // THE GAME'S THREE READS, all held here so ONE hold can stand through them (`GameHold`):
  // the day's puzzle; the language's word list, asked at once beside it (it needs only the
  // language) while there may be a game — never behind the first visit's invitation, and
  // dropped the moment the day turns out to have none (a big download for nothing); and the
  // round's server state, asked as soon as the puzzle names its revision (#214: the board is
  // replayed from it, so nothing is playable before it answers).
  const { puzzle, ref, error, noPuzzle, retry } = usePuzzle(lang, date, bonusId);
  const gameAhead = surface === 'game' && !noPuzzle;
  const { vocab, error: vocabError, retry: retryVocab } = useVocab(gameAhead ? lang : null);
  const roundKey = useMemo(() => roundKeyFor(ref, lang), [ref, lang]);
  const round = useRoundSync(
    puzzle
      ? { roundKey, lang, date: puzzleAddress(ref), revision: puzzle.revision, ranks: puzzle.ranks }
      : null,
  );
  const setLastLang = useGameStore((s) => s.setLastLang);

  // A dated route replays a past day when its date is not today's active game day; the
  // undated route is always the active day. Gates the streak celebration + solve analytics.
  // LIVE, off the app's one day signal: a dated route held open across the 22:00 flip
  // stops being the active day without a reload.
  const today = useToday();
  const isActiveDay = bonusId === undefined && (date == null || dayNumberOf(date) === today);

  // Once the round is on screen it STAYS (`game/roundOnScreen.ts`): a read it already
  // answered coming back out — an identity adopted from another tab, a republish — leaves the
  // round standing on what it had until the next answer replaces it, and a failure there is
  // the engine's retried hiccup behind a live board, never this screen's RETRY.
  const live: Shown | null =
    puzzle !== null && vocab !== null && round?.status === 'ready'
      ? { roundKey, puzzle, vocab, server: round.server }
      : null;
  const [kept, setKept] = useState<Shown | null>(null);
  const shown = roundOnScreen(kept, live, roundKey);
  if (shown !== kept) setKept(shown);
  // What the route can show: a day with none, else the game once all three reads are in, with
  // the hold standing until they are — and a read that FAILED (the puzzle; the word list, only
  // once the puzzle says there is a game to play with it; the round's) holds the hold STILL,
  // with its RETRY. The game is deliberately NETWORK-DEPENDENT at load (#214): until the round
  // read settles there is nothing honest to show and nothing to type into, and a FAILED read
  // is said, with a RETRY, rather than silently starting the player on a guessed local mirror
  // — the guesses they would then type would be answers to a board the server disagrees with.
  const failedRetry =
    error !== null
      ? retry
      : noPuzzle || puzzle === null || shown !== null
        ? null
        : vocabError !== null
          ? retryVocab
          : round?.status === 'failed'
            ? () => retryRoundSync(roundKey)
            : null;
  // (The invitation stands in for the hold while the reads go on behind it.)
  const hold = useHold(surface === 'game' && !noPuzzle && shown === null);
  // What the hold's tray promises: the KEYBOARD only to a player who lands on the prompt —
  // an account, and level 1 done (`Round`'s own `gateOpen`, read before the round is in) —
  // else the GATE's slots, LEARN's with them while the lesson is not done.
  const identity = useDeviceIdentity();
  const learned = useGameStore((s) => s.lessonsDone.includes(PLAY_LEVEL));
  const tray: HoldTray = identity !== null && learned ? 'keys' : learned ? 'gate' : 'gate-learn';
  // The holes the hold's silhouette lays out: the START words until the round's read is in,
  // then the board the round will mount on — its fresh holes walked through the play log of
  // what the server holds and what this device still owes (`Game`'s own first frame) — so a
  // returning player's best words land on their own boxes, never on the start words'.
  const roundServer = round?.status === 'ready' ? round.server : null;
  const owed = useGameStore((s) => s.outbox[roundKey]);
  const holdHoles = useMemo(() => {
    if (puzzle === null) return null;
    const fresh = freshHolesFor(puzzle.holes);
    if (roundServer === null) return fresh;
    const outbox = owed?.puzzle === puzzle.revision ? owed.guesses : [];
    return replayHoles(fresh, puzzle.ranks, playLogFor(puzzle.ranks, roundServer.guesses, outbox));
  }, [puzzle, roundServer, owed]);
  // A day already over hands over to its RESULT on bare ground: the hold goes at once rather
  // than showing through the card as it comes in.
  const over = shown !== null && (shown.server.solved || roundEnded(shown.server));

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
        onAccept={() => startLesson(lang)}
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
        <PuzzleTitle lang={lang} puzzleRef={isActiveDay ? null : ref} />
      </HeaderLeft>
      {/* `date` tells NoPuzzle whether this is an archive miss. */}
      {noPuzzle && <NoPuzzle lang={lang} date={date} bonus={bonusId !== undefined} />}
      {!noPuzzle && (
        // THE GAME'S COLUMN, the route's: the hold stands in it through the three reads and
        // gives way UNDER the round once they are in (first in the column, so the round
        // paints over it). A failed read holds it STILL — shown at once, whatever its wait —
        // with ONE line for all three reads (the player lost the same thing) and RETRY in the
        // prompt's row; a retry hands it back to breathing in place.
        <div className="game" aria-busy={shown !== null || failedRetry !== null ? undefined : true}>
          {hold.mounted && !over && (
            <GameHold
              lang={lang}
              puzzle={puzzle}
              holes={holdHoles}
              wordsIn={vocab !== null}
              roundIn={round?.status === 'ready'}
              race={isActiveDay}
              tray={tray}
              shown={hold.shown || failedRetry !== null}
              leaving={hold.leaving}
              failure={
                failedRetry && (
                  <QuietFailure
                    className="start"
                    lang={lang}
                    line={t(lang, isActiveDay ? 'failedGame' : 'failedGamePast')}
                    onRetry={failedRetry}
                  />
                )
              }
            />
          )}
          {shown !== null && (
            <Game
              puzzle={shown.puzzle}
              puzzleRef={ref}
              vocab={shown.vocab}
              server={shown.server}
              isActiveDay={isActiveDay}
              deferResultsAnimation={preview.streak != null}
              fromHold={hold.leaving}
            />
          )}
        </div>
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
      {preview.streak != null && !isBonusRef(ref) && (
        <LazyStreakDialog
          lang={lang}
          solvedDay={ref.dayNumber}
          previewPreviousStreak={preview.streak}
          onDismiss={preview.dismissStreak}
        />
      )}
    </>
  );
}
