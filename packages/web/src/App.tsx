import { useCallback, useEffect, useMemo, useState } from 'react';
import usePuzzle from './hooks/usePuzzle';
import LanguageSelect from './screens/LanguageSelect';
import Game from './screens/Game';
import LoadError from './components/LoadError';
import NoPuzzle from './components/NoPuzzle';
import Tutorial from './tutorial/Tutorial';
import { useGameStore } from './state/gameStore';
import { useLocation, navigate } from './routing';
import { parseRoute, resolveHomeLang, pathForLang, type LangCode } from './langs';
import { t } from './i18n';

export default function App() {
  const pathname = useLocation();
  const route = parseRoute(pathname);
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
  // this attribute. Non-game routes use the same resolution as the `/` redirect.
  const docLang =
    route.view === 'game' ? route.lang : resolveHomeLang(lastLang, navigator.language);
  useEffect(() => {
    document.documentElement.lang = docLang;
  }, [docLang]);

  return (
    <div className="app">
      {route.view === 'select' && <LanguageSelect />}
      {route.view === 'game' && <GameRoute lang={route.lang} />}
      {/* home: redirecting on the next tick — render nothing. */}
    </div>
  );
}

// One puzzle route (/fr, /en). Loads the day's puzzle for the language and records it
// as the last-played one. There is no header until the puzzle loads — Game owns the HUD
// (flag + progress bar), so it always shows the loaded puzzle's language.
function GameRoute({ lang }: { lang: LangCode }) {
  const { puzzle, dayNumber, error, loading, noPuzzle, retry } = usePuzzle(lang);
  const setLastLang = useGameStore((s) => s.setLastLang);
  const setOnboarded = useGameStore((s) => s.setOnboarded);

  // Visiting a puzzle route makes this the last-played language (seeds the `/` redirect).
  useEffect(() => {
    setLastLang(lang);
  }, [lang, setLastLang]);

  // Onboarding tutorial (#51): a first visit (no persisted `onboarded`) plays the
  // scripted dummy round INSTEAD of the day's puzzle — which keeps loading in the
  // background and is revealed when the tutorial finishes or is skipped (both set the
  // flag). `?tutorial=1` forces it (dev/testing); a `?puzzle=` override is a dev path
  // and wins over the first-visit trigger. The HUD's "?" re-opens it on demand.
  // The URL params are read once per page load, like the ?puzzle= override itself.
  const [forced, hasOverride] = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return [params.get('tutorial') === '1', params.has('puzzle')] as const;
  }, []);
  const [tutorialOpen, setTutorialOpen] = useState<boolean>(
    () => forced || (!useGameStore.getState().onboarded && !hasOverride),
  );
  const closeTutorial = useCallback(() => {
    setOnboarded();
    setTutorialOpen(false);
  }, [setOnboarded]);
  const openTutorial = useCallback(() => setTutorialOpen(true), []);

  // key={lang}: switching language mid-tutorial restarts it in that language.
  if (tutorialOpen) return <Tutorial key={lang} lang={lang} onDone={closeTutorial} />;

  return (
    <>
      {/* The header (HUD) only exists once a puzzle is loaded — Game renders it itself
          (flag + progress bar). The transient states below are header-less: loading /
          error show a bare status, and `noPuzzle` shows its own CHANGE LANGUAGE screen. */}
      {loading && <p className="status">{t(lang, 'loading')}</p>}
      {error !== null && <LoadError message={t(lang, 'failedPuzzle')} lang={lang} onRetry={retry} />}
      {noPuzzle && <NoPuzzle lang={lang} />}
      {puzzle && <Game puzzle={puzzle} dayNumber={dayNumber} onHelp={openTutorial} />}
    </>
  );
}
