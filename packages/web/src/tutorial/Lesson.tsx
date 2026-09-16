import { useCallback } from 'react';
import { useGameStore } from '../state/gameStore';
import { track } from '../analytics';
import { pathForGame, type LangCode } from '../langs';
import { navigate } from '../routing';
import LazyLevelOne from './LazyLevelOne';
import { PLAY_LEVEL } from './levels';

// ONE LEVEL'S LESSON, on its route (#269). Its end — the run's PLAY — records the level as
// done on this device, settles the onboarding question for good (the first visit's
// invitation never asks again) and lands in the game. Leaving by the header instead is a
// SKIP: App's `leave` settles the question the same way and records nothing done.
export default function Lesson({ lang, level }: { lang: LangCode; level: number }) {
  const markLessonDone = useGameStore((s) => s.markLessonDone);
  const setOnboarded = useGameStore((s) => s.setOnboarded);
  const finish = useCallback(() => {
    track('tutorial', { action: 'finish' });
    markLessonDone(level);
    setOnboarded();
    navigate(pathForGame(lang));
  }, [lang, level, markLessonDone, setOnboarded]);

  // Only level 1 is built (levels.ts); parseRoute lands every other level on the list.
  if (level !== PLAY_LEVEL) return null;
  // key={lang}: a language pick in the header restarts the lesson in that language.
  return <LazyLevelOne key={lang} lang={lang} onDone={finish} />;
}
