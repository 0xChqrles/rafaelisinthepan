import { useCallback, useMemo, useState } from 'react';
import LangTitle from '../components/LangTitle';
import { HeaderLeft } from '../components/TopBar';
import useVocab from '../hooks/useVocab';
import { t } from '../i18n';
import { pathForLesson, type LangCode } from '../langs';
import LessonBoard from './LessonBoard';
import { LEVELS, PLAY_LEVEL } from './levels';
import { scriptFor } from './scripts';

// LEVEL 1 — THE GAME, PLAYED (#269): the script's stages on one screen — the reveal, the
// word, the sentence — each a real board (LessonBoard). The header stays in place throughout with the BOOK lit;
// its left slot is the level's name and the language it is taught in — a pick NAVIGATES to
// the same lesson in that language, and App keys the screen on it, so it restarts there.
export default function LevelOne({ lang, onDone }: { lang: LangCode; onDone: () => void }) {
  const script = useMemo(() => scriptFor(lang), [lang]);
  const [at, setAt] = useState(0);
  // ONE vocabulary for both stages, loaded at mount so the keyboard is live on the first
  // frame of the sentence — and already cached for the game right after.
  const { vocab, error, retry } = useVocab(lang);
  const next = useCallback(() => setAt((i) => i + 1), []);
  const title = t(lang, LEVELS.find((l) => l.level === PLAY_LEVEL)!.titleKey);

  return (
    <>
      <HeaderLeft>
        <LangTitle lang={lang} title={title} to={(picked) => pathForLesson(picked, PLAY_LEVEL)} />
      </HeaderLeft>
      {/* key={at}: a stage is a fresh board with fresh state; the tray remounts with it,
          which is instant — nothing animates between two stages. */}
      <LessonBoard
        key={at}
        lang={lang}
        script={script.stages[at]}
        step={at + 1}
        totalSteps={script.stages.length}
        vocab={vocab}
        vocabError={error}
        retryVocab={retry}
        final={at === script.stages.length - 1}
        onComplete={next}
        onPlay={onDone}
      />
    </>
  );
}
