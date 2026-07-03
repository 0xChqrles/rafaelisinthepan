import { useEffect } from 'react';
import usePuzzle from './hooks/usePuzzle';
import LanguageSelect from './screens/LanguageSelect';
import Game from './screens/Game';
import FlagButton from './components/FlagButton';
import LoadError from './components/LoadError';
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
// as the last-played one. The HUD flag shows the LOADED puzzle's language (falling back
// to the route language until it resolves), so it is always the flag of what's on screen.
function GameRoute({ lang }: { lang: LangCode }) {
  const { puzzle, dayNumber, error, loading, noPuzzle, retry } = usePuzzle(lang);
  const setLastLang = useGameStore((s) => s.setLastLang);

  // Visiting a puzzle route makes this the last-played language (seeds the `/` redirect).
  useEffect(() => {
    setLastLang(lang);
  }, [lang, setLastLang]);

  const flagLang = puzzle?.lang ?? lang;

  return (
    <>
      {/* Non-game states (loading / error / no puzzle) get a bare HUD with just the
          flag; once a puzzle loads, Game renders the full HUD (flag + progress bar), so
          exactly one HUD shows at a time. */}
      {!puzzle && (
        <div className="hud">
          <FlagButton lang={flagLang} />
        </div>
      )}

      {loading && <p className="status">LOADING&hellip;</p>}
      {error !== null && <LoadError message="FAILED TO LOAD PUZZLE" onRetry={retry} />}
      {noPuzzle && <p className="status">NO PUZZLE TODAY</p>}
      {puzzle && <Game puzzle={puzzle} dayNumber={dayNumber} />}
    </>
  );
}
