import { useCallback, useEffect, useMemo, useState } from 'react';
import LangTitle from '../components/LangTitle';
import { HeaderLeft } from '../components/TopBar';
import useVocab from '../hooks/useVocab';
import { useGameStore } from '../state/gameStore';
import { t } from '../i18n';
import { pathForLesson, type LangCode } from '../langs';
import { preloadScenes } from './art/LevelArt';
import LessonBoard from './LessonBoard';
import { LEVELS, PLAY_LEVEL } from './levels';
import { scriptFor } from './scripts';

// LEVEL 1 — THE GAME, PLAYED (#269): the script's stages on one screen — the reveal, the
// word, the sentence — each a real board (LessonBoard). The header stays in place throughout with the BOOK lit;
// its left slot is the level's name and the language it is taught in — a pick NAVIGATES to
// the same lesson in that language, and App keys the screen on it, so it restarts there.
// The run ends on the level's own card turning DONE (`onCleared`), PLAY under it (`onDone`).
export default function LevelOne({
  lang,
  onDone,
  onCleared,
}: {
  lang: LangCode;
  onDone: () => void;
  onCleared: () => void;
}) {
  const script = useMemo(() => scriptFor(lang), [lang]);
  const [at, setAt] = useState(0);
  // ONE vocabulary for both stages, loaded at mount so the keyboard is live on the first
  // frame of the sentence — and already cached for the game right after.
  const { vocab, error, retry } = useVocab(lang);
  const next = useCallback(() => setAt((i) => i + 1), []);
  // Read once: the finale's card turns DONE only for a player it is new to.
  const [clearedBefore] = useState(() => useGameStore.getState().lessonsDone.includes(PLAY_LEVEL));
  // The finale's picture must be there when its card lands.
  useEffect(preloadScenes, []);
  const title = t(lang, LEVELS.find((l) => l.level === PLAY_LEVEL)!.titleKey);

  return (
    <>
      <HeaderLeft>
        <LangTitle lang={lang} title={title} to={(picked) => pathForLesson(picked, PLAY_LEVEL)} />
      </HeaderLeft>
      {/* key={at}: a stage is a fresh board with fresh state, scrambling in from the text the
          stage before it ended on. */}
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
        arrivedFrom={at > 0 ? script.stages[at - 1].puzzle.words.join(' ') : undefined}
        clearedBefore={clearedBefore}
        onComplete={next}
        onPlay={onDone}
        onCleared={onCleared}
      />
    </>
  );
}
