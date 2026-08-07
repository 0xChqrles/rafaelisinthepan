import Flag from '../components/Flag';
import Chooser, { ChooserCard } from '../components/Chooser';
import { LANGS, pathForMode, resolveHomeLang } from '../langs';
import { navigate } from '../routing';
import useToday from '../hooks/useToday';
import { useGameStore, roundKeyForDay } from '../state/gameStore';
import { statusOf, wordStatusOf } from '../state/status';

// The language chooser (/select), reached from the header globe on every screen — the
// game AND the tutorial (whose transient open-state survives the round-trip, so picking
// a language returns into it). One card per language: full-opacity flag + the language's
// NATIVE name, in a list that scales to any number of languages. The per-(day,lang)
// persist keeps each language's in-progress state, so switching needs no confirmation.
// The screen itself is the shared `Chooser` — see it for the shell and the card.
export default function LanguageSelect() {
  const dayNumber = useToday();
  const rounds = useGameStore((s) => s.rounds);
  const wordRounds = useGameStore((s) => s.wordRounds);
  const lastLang = useGameStore((s) => s.lastLang);
  // A card lands on the LAST-PLAYED MODE (#156, the same rule as the `/` redirect), so
  // its status strip reads that mode's round — the day the tap will actually open.
  const mode = useGameStore((s) => s.lastMode) ?? 'sentence';
  // This screen has no puzzle to take a language from; its chrome follows the same
  // resolution as the `/` redirect (last played, else browser, else English).
  const uiLang = resolveHomeLang(lastLang, navigator.language);

  return (
    <Chooser>
      {LANGS.map(({ code, native }) => (
        <ChooserCard
          key={code}
          name={native}
          uiLang={uiLang}
          icon={<Flag code={code} className="chooser-card-icon" />}
          status={
            mode === 'word'
              ? wordStatusOf(wordRounds[roundKeyForDay(dayNumber, code, 'word')])
              : statusOf(rounds[roundKeyForDay(dayNumber, code)])
          }
          onClick={() => navigate(pathForMode(code, mode))}
        />
      ))}
    </Chooser>
  );
}
