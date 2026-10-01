import { useCallback } from 'react';
import { useGameStore } from '../state/gameStore';
import { track } from '../analytics';
import { pathForGame, pathForLearn, type LangCode } from '../langs';
import { navigate } from '../routing';
import LazyArticle from './LazyArticle';
import LazyLevelOne from './LazyLevelOne';
import { PLAY_LEVEL } from './levels';

// ONE LEVEL'S LESSON, on its route (#269). Level 1 is PLAYED: its end — the level's card
// turning DONE, then the run's PLAY — records the level as done on this device, settles the
// onboarding question for good (the first visit's invitation never asks again) and lands in
// the game. Leaving it by the header instead is a SKIP: App's `leave` settles the question
// the same way and records nothing done. Every other level is an ARTICLE (`ArticleLevel`):
// it records nothing and has nothing to do with the onboarding.
export default function Lesson({ lang, level, returnTo }: {
  lang: LangCode;
  level: number;
  returnTo?: string;
}) {
  const destination = returnTo ?? pathForGame(lang);
  const markLessonDone = useGameStore((s) => s.markLessonDone);
  const setOnboarded = useGameStore((s) => s.setOnboarded);
  const finish = useCallback(() => {
    track('tutorial', { action: 'finish' });
    markLessonDone(level);
    setOnboarded();
    navigate(destination);
  }, [destination, level, markLessonDone, setOnboarded]);
  const unavailable = useCallback(() => {
    setOnboarded();
    navigate(destination);
  }, [destination, setOnboarded]);
  const cleared = useCallback(() => markLessonDone(PLAY_LEVEL), [markLessonDone]);
  const articleUnavailable = useCallback(() => navigate(pathForLearn(lang)), [lang]);

  // key={lang}: a language pick in the header restarts the lesson in that language — and an
  // article is keyed by its level too, so the next one starts unread, at its top.
  if (level !== PLAY_LEVEL) {
    return <LazyArticle key={`${lang}:${level}`} lang={lang} level={level} onUnavailable={articleUnavailable} />;
  }
  return <LazyLevelOne key={lang} lang={lang} onDone={finish} onCleared={cleared} onUnavailable={unavailable} />;
}
