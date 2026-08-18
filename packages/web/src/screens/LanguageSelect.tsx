import Chooser, { ChooserCard } from '../components/Chooser';
import { LANGS, pathForMode, resolveHomeLang } from '../langs';
import { navigate } from '../routing';
import useToday from '../hooks/useToday';
import { useDeadlineRefresh } from '../hooks/useCountdown';
import { useGameStore, roundKeyForDay } from '../state/gameStore';
import { statusOf, wordStatusOf } from '../state/status';

// The language chooser (/select), reached from the header globe on every screen — the
// game AND the tutorial (whose transient open-state survives the round-trip, so picking
// a language returns into it). One card per language: the language's NATIVE name,
// centred (the flags left with the card art, 2026-08-17 — Flag.tsx and the flag PNGs
// deleted with their last consumer), in a list that scales to any number of languages. The per-(day,lang)
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
  // Both languages can have overlapping live runs. Wake for the first deadline; the hook
  // then selects the next one, so each card becomes done at its own wall-clock end.
  useDeadlineRefresh(
    mode === 'word'
      ? LANGS.map(({ code }) => wordRounds[roundKeyForDay(dayNumber, code, 'word')]?.deadline)
      : [],
  );

  return (
    <Chooser>
      {LANGS.map(({ code, native }) => (
        <ChooserCard
          key={code}
          name={native}
          tag={code.toUpperCase()}
          uiLang={uiLang}
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
