import { useEffect } from 'react';
import usePuzzle from './hooks/usePuzzle';
import LanguageSelect from './screens/LanguageSelect';
import Game from './screens/Game';
import LoadError from './components/LoadError';
import NoPuzzle from './components/NoPuzzle';
import { useGameStore } from './state/gameStore';
import { useLocation, navigate } from './routing';
import { parseRoute, resolveHomeLang, pathForLang, type LangCode } from './langs';

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

  // Visiting a puzzle route makes this the last-played language (seeds the `/` redirect).
  useEffect(() => {
    setLastLang(lang);
  }, [lang, setLastLang]);

  return (
    <>
      {/* The header (HUD) only exists once a puzzle is loaded — Game renders it itself
          (flag + progress bar). The transient states below are header-less: loading /
          error show a bare status, and `noPuzzle` shows its own CHANGE LANGUAGE screen. */}
      {loading && <p className="status">LOADING&hellip;</p>}
      {error !== null && <LoadError message="FAILED TO LOAD PUZZLE" onRetry={retry} />}
      {noPuzzle && <NoPuzzle lang={lang} />}
      {puzzle && <Game puzzle={puzzle} dayNumber={dayNumber} />}
    </>
  );
}
