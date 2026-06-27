import { useEffect, useState } from 'react';
import usePuzzle from './hooks/usePuzzle';
import LanguageSelect from './screens/LanguageSelect';
import Game from './screens/Game';
import Button from './components/Button';

export default function App() {
  const [lang, setLang] = useState<string | null>(null);
  const { puzzle, error, loading, noPuzzle } = usePuzzle(lang);

  useEffect(() => {
    if (!lang) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setLang(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [lang]);

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
      {lang && puzzle && <Game puzzle={puzzle} />}
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
