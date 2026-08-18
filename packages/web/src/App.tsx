import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { activeDate } from '@whippin/shared';
import usePuzzle from './hooks/usePuzzle';
import useWordPuzzle from './hooks/useWordPuzzle';
import LanguageSelect from './screens/LanguageSelect';
import Archive from './screens/Archive';
import Game from './screens/Game';
import WordGame from './screens/WordGame';
import TopBar from './components/TopBar';
import ModeTabs from './components/ModeTabs';
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
  resolveHomeLang,
  pathForMode,
  pathForArchive,
  type LangCode,
  type Mode,
} from './langs';
import { t } from './i18n';
import useToday from './hooks/useToday';
import { streakPreviewFromSearch } from './dev/streakPreview';
// This route's own header control. Decorative glyph; the button's aria-label names it.
import QuestionIcon from './assets/icons/question.svg?react';

export default function App() {
  const pathname = useLocation();
  // The client's active game day bounds the date deep-link range (a future date -> home),
  // so parsing gets it here (kept out of parseRoute so parsing stays pure/testable).
  const route = parseRoute(pathname, { activeDate: activeDate(new Date()) });
  const lastLang = useGameStore((s) => s.lastLang);
  const lastMode = useGameStore((s) => s.lastMode);

  // The game IS the home: `/` (and any unknown path) redirects to a language — the
  // persisted last-played one, else the browser language (fr* -> /fr), else English —
  // in the LAST-PLAYED MODE (#156: arrival lands on it, like lastLang; a first visit
  // has no preference and lands on the sentence). replaceState so `/` never lingers in
  // history: back from the game exits instead of bouncing through the redirect, and a
  // deep link to /fr or /en never redirects.
  useEffect(() => {
    if (route.view !== 'home') return;
    navigate(
      pathForMode(resolveHomeLang(lastLang, navigator.language), lastMode ?? 'sentence'),
      { replace: true },
    );
  }, [route.view, lastLang, lastMode]);

  // Keep <html lang> honest: index.html ships lang="en", but on /fr both the puzzle
  // content and the UI chrome are French — screen readers pick pronunciation rules from
  // this attribute. Language-scoped routes (game + archive) use their own lang; the
  // language-less routes use the same resolution as the `/` redirect.
  const docLang =
    route.view === 'game' || route.view === 'archive'
      ? route.lang
      : resolveHomeLang(lastLang, navigator.language);
  useEffect(() => {
    document.documentElement.lang = docLang;
  }, [docLang]);

  // The frame's edition serial is the ACTIVE day's own index — today's number whatever
  // screen is up (an archived day's date already reads in the header's date chip).
  const editionDay = useToday();

  return (
    <div className="app">
      {/* The viewport's own furniture (decorative, desktop-only) — under every screen. */}
      <DeviceFrame serial={editionDay} />
      {/* The living backdrop — every screen (game, archive, select, tutorial) sits on it. */}
      {route.view === 'select' && <LanguageSelect />}
      {route.view === 'archive' && <Archive lang={route.lang} mode={route.mode} />}
      {route.view === 'game' && (
        <GameRoute lang={route.lang} mode={route.mode} date={route.date} />
      )}
      {/* home: redirecting on the next tick — render nothing. */}
    </div>
  );
}

// One puzzle route: /<lang> plays today's sentence, /<lang>/<date> replays a past
// archive day (#55), and /<lang>/word[/<date>] is Word mode's daily (#156) — one route
// component for both faces, so the header, the tutorial gate and the transient states
// (loading / error / missing-puzzle) cannot drift between them. Loads the day's
// artifact for the language and records it as the last-played language AND mode. The
// header (TopBar) is owned HERE — above every transient state and the loaded game alike.
// A loaded screen only reports the live content for its left slot, so the header itself
// stays put while the body swaps.
function GameRoute({ lang, mode, date }: { lang: LangCode; mode: Mode; date?: string }) {
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
  // the question for good (either sets the flag). The header's "?" re-opens the
  // tutorial as a `replay`; the fast-forward in the tutorial's own header skips it.
  // The open-tutorial state lives in the STORE (transient) so the tutorial's flag can
  // round-trip through the /select screen — this route unmounts, and picking a
  // language re-mounts it with the tutorial still open, now in that language.
  // `?tutorial=1` forces it (dev/testing). URL params are read once per load.
  // The tutorial is MODE-AGNOSTIC on purpose: it teaches the rank mechanic both dailies
  // share, and its routes ending is Word mode's primer (#155/#156).
  const forced = useMemo(
    () => new URLSearchParams(window.location.search).get('tutorial') === '1',
    [],
  );
  // Dev-only animation harness: the value is the PREVIOUS streak, so ?streak=9 previews
  // 9 -> 10 immediately without mutating persisted rounds or solved-day history.
  const [streakPreview, setStreakPreview] = useState<number | null>(() =>
    streakPreviewFromSearch(window.location.search),
  );
  // Stable across renders: StreakDialog keys its whole staged sequence on onDismiss, so
  // an inline closure would restart the animation every time this route re-renders.
  const dismissStreakPreview = useCallback(() => setStreakPreview(null), []);
  const onboarded = useGameStore((s) => s.onboarded);
  const tutorialOpen = useGameStore((s) => s.tutorialOpen);
  const openTutorial = useGameStore((s) => s.openTutorial);
  // The dev force-flag opens it once per mount, before the first paint.
  useState(() => {
    if (forced && !useGameStore.getState().tutorialOpen) openTutorial('first');
    return null;
  });
  const closeTutorial = useCallback(() => {
    setOnboarded();
    useGameStore.getState().closeTutorial();
  }, [setOnboarded]);

  // The header itself stays mounted at this route boundary. A loaded game reports the
  // live content for its left slot; keying the report prevents a departing route's
  // layout-effect cleanup from blanking the next route's status.
  const headerKey = `${lang}:${mode}:${date ?? 'today'}`;
  const [headerLeft, setHeaderLeft] = useState<{
    key: string;
    content: ReactNode | null;
  } | null>(null);
  const updateHeaderLeft = useCallback(
    (content: ReactNode | null) => setHeaderLeft({ key: headerKey, content }),
    [headerKey],
  );
  const currentHeaderLeft = headerLeft?.key === headerKey ? headerLeft.content : undefined;

  // key={lang}: switching language mid-tutorial (via /select) restarts it in that
  // language.
  if (tutorialOpen) {
    return <LazyTutorial key={lang} lang={lang} onDone={closeTutorial} />;
  }
  if (!onboarded && streakPreview == null) {
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

  // The two CHOOSERS (mode, language) are the header's own — see TopBar; `modeChooser`
  // below opts this route into the first. What follows is this screen's own controls.
  const headerRight = (
    <>
      {/* Replays the onboarding tutorial (#51) on demand — one tap, out of the way.
          (The archive icon left the header 2026-08-18: the DATE CHIP is the archive
          entry now — see PuzzleDate.) */}
      <button
        type="button"
        className="home-btn help-btn"
        aria-label={t(lang, 'ariaHelp')}
        onClick={() => openTutorial('replay')}
      >
        <QuestionIcon className="ui-icon" aria-hidden />
      </button>
    </>
  );
  return (
    <>
      {/* The route owns one persistent actual header. Loaded games populate its left slot;
          loading/error/missing states leave it empty. */}
      <TopBar
        lang={lang}
        left={currentHeaderLeft}
        center={<ModeTabs lang={lang} mode={mode} onSelect={(m) => navigate(pathForMode(lang, m))} />}
        right={headerRight}
      />
      {loading && <p className="status">{t(lang, 'loading')}</p>}
      {error !== null && <LoadError message={t(lang, 'failedPuzzle')} lang={lang} onRetry={retry} />}
      {/* `date` tells NoPuzzle whether this is an archive miss; `mode` keeps its return
          route on the same daily game's calendar. */}
      {noPuzzle && <NoPuzzle lang={lang} mode={mode} date={date} />}
      {mode === 'sentence' && sentence.puzzle && (
        <Game
          puzzle={sentence.puzzle}
          dayNumber={dayNumber}
          isActiveDay={isActiveDay}
          deferResultsAnimation={streakPreview != null}
          onHeaderLeftChange={updateHeaderLeft}
        />
      )}
      {mode === 'word' && word.puzzle && (
        <WordGame
          puzzle={word.puzzle}
          dayNumber={dayNumber}
          onHeaderLeftChange={updateHeaderLeft}
        />
      )}
      {streakPreview != null && (
        <LazyStreakDialog
          lang={lang}
          solvedDay={dayNumber}
          previewPreviousStreak={streakPreview}
          onDismiss={dismissStreakPreview}
        />
      )}
    </>
  );
}
