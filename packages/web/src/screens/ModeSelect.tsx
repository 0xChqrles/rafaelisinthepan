import Chooser, { ChooserCard } from '../components/Chooser';
import { pathForMode, resolveHomeLang, type Mode } from '../langs';
import { navigate } from '../routing';
import useToday from '../hooks/useToday';
import { useDeadlineRefresh } from '../hooks/useCountdown';
import { useGameStore, roundKeyForDay } from '../state/gameStore';
import { statusOf, wordStatusOf } from '../state/status';
import { t } from '../i18n';
import sentenceIcon from '../assets/icons/sentence1.png';
import wordIcon from '../assets/icons/word.png';

// The game-mode chooser (/mode, #156), reached from the header's Whippin mark — the twin
// of the language chooser, asked about the other axis. It replaced the header TOGGLE
// (decided 2026-08-06): a toggle showed one icon meaning "the mode you are NOT in", which
// has to be decoded, and it could only ever flip between two — where a chooser SHOWS both
// dailies side by side with today's progress on each, and stays right when a third arrives.
//
// A card lands on the LAST-PLAYED LANGUAGE (the same rule the language cards use for the
// mode): the two choosers each hold the other's axis fixed, so neither can strand you.
const MODES: { mode: Mode; nameKey: 'modeSentence' | 'modeWord'; icon: string }[] = [
  { mode: 'sentence', nameKey: 'modeSentence', icon: sentenceIcon },
  { mode: 'word', nameKey: 'modeWord', icon: wordIcon },
];

export default function ModeSelect() {
  const dayNumber = useToday();
  const rounds = useGameStore((s) => s.rounds);
  const wordRounds = useGameStore((s) => s.wordRounds);
  const lastLang = useGameStore((s) => s.lastLang);
  // No puzzle to take a language from, so the chrome — and the language a card opens —
  // resolve exactly like the `/` redirect (last played, else browser, else English).
  const uiLang = resolveHomeLang(lastLang, navigator.language);
  const wordRound = wordRounds[roundKeyForDay(dayNumber, uiLang, 'word')];
  // Date.now() is not reactive: if this chooser stays open while the run expires, wake it
  // once so the Word card moves from progress to done without a navigation or store write.
  useDeadlineRefresh([wordRound?.deadline]);

  return (
    <Chooser>
      {MODES.map(({ mode, nameKey, icon }) => (
        <ChooserCard
          key={mode}
          name={t(uiLang, nameKey)}
          uiLang={uiLang}
          icon={<img className="chooser-card-icon mode-sprite" src={icon} alt="" draggable="false" />}
          status={
            mode === 'word'
              ? wordStatusOf(wordRound)
              : statusOf(rounds[roundKeyForDay(dayNumber, uiLang)])
          }
          onClick={() => navigate(pathForMode(uiLang, mode))}
        />
      ))}
    </Chooser>
  );
}
