import { dateForDayNumber } from '@whippin/shared';
import Chooser, { ChooserCard } from '../components/Chooser';
import { LANGS, pathForMode, resolveHomeLang, type LangCode, type Mode } from '../langs';
import { navigate } from '../routing';
import useToday from '../hooks/useToday';
import { useDeadlineRefresh } from '../hooks/useCountdown';
import { useGameStore, roundKeyForDay, type WordRoundProgress } from '../state/gameStore';
import { daySummaryStatus, usePlayerHistory } from '../state/history';
import { wordStatusOf } from '../state/status';
import { yearMonthOf, isoMonth } from '../calendar';

// The language chooser (/select), reached from the header globe on every screen — the
// game AND the tutorial (whose transient open-state survives the round-trip, so picking
// a language returns into it). One card per language: the language's NATIVE name,
// centred (the flags left with the card art, 2026-08-17 — Flag.tsx and the flag PNGs
// deleted with their last consumer), in a list that scales to any number of languages.
// Switching needs no confirmation: the server owns each round.
// The screen itself is the shared `Chooser` — see it for the shell and the card.
export default function LanguageSelect() {
  const dayNumber = useToday();
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
        <LanguageCard
          key={code}
          code={code}
          native={native}
          uiLang={uiLang}
          mode={mode}
          dayNumber={dayNumber}
          wordRound={wordRounds[roundKeyForDay(dayNumber, code, 'word')]}
        />
      ))}
    </Chooser>
  );
}

// One card, and the reason this is a COMPONENT rather than a loop body: a SENTENCE card's
// status is a private server read (#211), one per language, so each card owns a hook. The
// chooser follows the archive's explicit-loading rule — a strip is drawn from a summary
// that ARRIVED or not at all, never from a guess that the day is untouched.
function LanguageCard({
  code,
  native,
  uiLang,
  mode,
  dayNumber,
  wordRound,
}: {
  code: LangCode;
  native: string;
  uiLang: string;
  mode: Mode;
  dayNumber: number;
  wordRound: WordRoundProgress | undefined;
}) {
  // TODAY's row of the CURRENT month: the chooser wants one day, and the month read is
  // what already answers it — one shape of private history, not a second route for a
  // single day.
  const date = dateForDayNumber(dayNumber);
  const history = usePlayerHistory({
    lang: code,
    mode: 'sentence',
    month: isoMonth(yearMonthOf(date)),
    enabled: mode === 'sentence',
  });

  return (
    <ChooserCard
      name={native}
      tag={code.toUpperCase()}
      uiLang={uiLang}
      status={mode === 'word' ? wordStatusOf(wordRound) : daySummaryStatus(history, date)}
      onClick={() => navigate(pathForMode(code, mode))}
    />
  );
}
