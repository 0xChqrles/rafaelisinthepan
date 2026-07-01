import { useEffect } from 'react';
import usePuzzle from './hooks/usePuzzle';
import LanguageSelect from './screens/LanguageSelect';
import Game from './screens/Game';
import Button from './components/Button';
import { useGameStore } from './state/gameStore';
import { langFromPath, pathForLang } from './langs';

export default function App() {
  // Selected language lives in the store; usePuzzle turns it into today's puzzle
  // and the server's dayNumber (the key the round's persisted progress is stored on).
  const lang = useGameStore((s) => s.lang);
  const setLang = useGameStore((s) => s.setLang);
  const { puzzle, dayNumber, error, loading, noPuzzle } = usePuzzle(lang);

  // Keep the address bar in sync with the language: /fr, /en, or / for the picker.
  // This makes a language deep-linkable — sharing /fr or refreshing stays in that
  // game (the store seeds `lang` from the path on load) instead of returning to the
  // picker. Guard the push so the seed load doesn't add a duplicate history entry.
  useEffect(() => {
    const path = pathForLang(lang);
    if (window.location.pathname !== path) {
      window.history.pushState(null, '', path + window.location.search);
    }
  }, [lang]);

  // Browser back/forward: follow the URL back to the matching language (or the picker).
  useEffect(() => {
    const onPop = () => setLang(langFromPath(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [setLang]);

  useEffect(() => {
    if (!lang) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setLang(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [lang, setLang]);

  return (
    <div className="app">
      {!lang && <LanguageSelect onSelect={setLang} />}

      {lang && (
        <Button variant="secondary" className="esc-label" onClick={() => setLang(null)}>
          [ESC]
        </Button>
      )}

      {lang && loading && <p className="status">LOADING&hellip;</p>}
      {lang && error !== null && <p className="status error">FAILED TO LOAD PUZZLE</p>}
      {lang && puzzle && <Game puzzle={puzzle} dayNumber={dayNumber} />}
      {lang && noPuzzle && (
        <div className="empty-lang">
          <p className="status">NO PUZZLE TODAY</p>
          <FlagBackButton onClick={() => setLang(null)} />
        </div>
      )}
    </div>
  );
}

function FlagBackButton({ onClick }: { onClick: () => void }) {
  return <Button onClick={onClick}>BACK</Button>;
}
