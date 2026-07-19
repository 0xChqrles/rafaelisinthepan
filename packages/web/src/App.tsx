import { useCallback, useEffect, useMemo, useState } from 'react';
import { activeDate } from '@whippin/shared';
import usePuzzle from './hooks/usePuzzle';
import LanguageSelect from './screens/LanguageSelect';
import Archive from './screens/Archive';
import Game from './screens/Game';
import TopBar from './components/TopBar';
import LazyStreakDialog from './components/LazyStreakDialog';
import LoadError from './components/LoadError';
import NoPuzzle from './components/NoPuzzle';
import Tutorial from './tutorial/Tutorial';
import Invite from './tutorial/Invite';
import { useGameStore } from './state/gameStore';
import { track } from './analytics';
import { useLocation, navigate } from './routing';
import { parseRoute, resolveHomeLang, pathForLang, pathForArchive, type LangCode } from './langs';
import { t } from './i18n';
import { streakPreviewFromSearch } from './dev/streakPreview';
// Inline SVG (vite-plugin-svgr): the header controls — calendar into the archive (#55)
// and the "?" help that replays the tutorial. Decorative glyphs; the buttons' aria-labels
// name them.
import CalendarIcon from './assets/icons/calendar.svg?react';
import QuestionIcon from './assets/icons/question.svg?react';

export default function App() {
  const pathname = useLocation();
  // The client's active game day bounds the date deep-link range (a future date -> home),
  // so parsing gets it here (kept out of parseRoute so parsing stays pure/testable).
  const route = parseRoute(pathname, { activeDate: activeDate(new Date()) });
  const lastLang = useGameStore((s) => s.lastLang);

  // The game IS the home: `/` (and any unknown path) redirects to a language — the
  // persisted last-played one, else the browser language (fr* -> /fr), else English.
  // replaceState so `/` never lingers in history: back from the game exits instead of
  // bouncing through the redirect, and a deep link to /fr or /en never redirects.
  useEffect(() => {
    if (route.view !== 'home') return;
    navigate(pathForLang(resolveHomeLang(lastLang, navigator.language)), { replace: true });
  }, [route.view, lastLang]);

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

  return (
    <div className="app">
      {route.view === 'select' && <LanguageSelect />}
      {route.view === 'archive' && <Archive lang={route.lang} />}
      {route.view === 'game' && <GameRoute lang={route.lang} date={route.date} />}
      {/* home: redirecting on the next tick — render nothing. */}
    </div>
  );
}

// One puzzle route: /<lang> plays today's puzzle, /<lang>/<date> replays a past archive
// day (#55). Loads the day's puzzle for the language and records it as the last-played
// one. The header (TopBar) is rendered HERE — above every transient state (loading /
// error / noPuzzle) and the loaded Game alike — so it stays put while only the body swaps
// (a navigation into a game never blinks the header, matching the archive direction). The
// game body owns just its progress-bar row + play area below the fixed header.
function GameRoute({ lang, date }: { lang: LangCode; date?: string }) {
  const { puzzle, dayNumber, error, loading, noPuzzle, retry } = usePuzzle(lang, date);
  const setLastLang = useGameStore((s) => s.setLastLang);
  const setOnboarded = useGameStore((s) => s.setOnboarded);

  // A dated route replays a past day when its date is not today's active game day; the
  // undated route is always the active day. Gates the streak celebration + solve analytics.
  const isActiveDay = date == null || date === activeDate(new Date());

  // Visiting a puzzle route makes this the last-played language (seeds the `/` redirect).
  useEffect(() => {
    setLastLang(lang);
  }, [lang, setLastLang]);

  // Onboarding tutorial (#51): it NEVER starts without an action. A first visit (no
  // persisted `onboarded`) lands on the INVITATION — standing in for the loading
  // screen while the day's puzzle fetches behind it — and TUTORIAL / SKIP both settle
  // the question for good (either sets the flag). The header's "?" re-opens the
  // tutorial as a `replay`; the fast-forward in the tutorial's own header skips it.
  // The open-tutorial state lives in the STORE (transient) so the tutorial's flag can
  // round-trip through the /select screen — this route unmounts, and picking a
  // language re-mounts it with the tutorial still open, now in that language.
  // `?tutorial=1` forces it (dev/testing). URL params are read once per load.
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

  // key={lang}: switching language mid-tutorial (via /select) restarts it in that
  // language.
  if (tutorialOpen) {
    return <Tutorial key={lang} lang={lang} onDone={closeTutorial} />;
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

  return (
    <>
      {/* One persistent header for the whole route: flag (language screen) + live streak on
          the left, the archive + help controls on the right, no center title. It renders in
          EVERY state below — loading, error, the missing-puzzle screen, and the loaded game —
          so navigating into a game never blinks the header away; only the body under it
          refreshes. (`dayNumber` is still usePuzzle's STABLE, once-at-fetch value — it just
          no longer surfaces in the header; it keys the round + share below.) */}
      <TopBar
        lang={lang}
        right={
          <div className="topbar-right">
            {/* Into the archive calendar (#55) — past days, one tap from the game. */}
            <button
              type="button"
              className="home-btn archive-btn"
              aria-label={t(lang, 'ariaArchive')}
              onClick={() => navigate(pathForArchive(lang))}
            >
              <CalendarIcon className="pixel-icon" aria-hidden />
            </button>
            {/* Replays the onboarding tutorial (#51) on demand — one tap, out of the way. */}
            <button
              type="button"
              className="home-btn help-btn"
              aria-label={t(lang, 'ariaHelp')}
              onClick={() => openTutorial('replay')}
            >
              <QuestionIcon className="pixel-icon" aria-hidden />
            </button>
          </div>
        }
      />
      {loading && <p className="status">{t(lang, 'loading')}</p>}
      {error !== null && <LoadError message={t(lang, 'failedPuzzle')} lang={lang} onRetry={retry} />}
      {noPuzzle && <NoPuzzle lang={lang} />}
      {puzzle && (
        <Game
          puzzle={puzzle}
          dayNumber={dayNumber}
          isActiveDay={isActiveDay}
          deferResultsAnimation={streakPreview != null}
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
