import { useEffect, useState } from 'react';
import type { ComponentProps, ComponentType } from 'react';
import type Tutorial from './Tutorial';
import { t } from '../i18n';

type TutorialProps = ComponentProps<typeof Tutorial>;
type TutorialComponent = ComponentType<TutorialProps>;

let loadedTutorial: TutorialComponent | null = null;
let tutorialModulePromise: Promise<TutorialComponent> | null = null;

function loadTutorial() {
  if (!tutorialModulePromise) {
    tutorialModulePromise = import('./Tutorial')
      .then((module) => {
        loadedTutorial = module.default;
        return loadedTutorial;
      })
      .catch((error) => {
        // A failed idle preload must not poison the later user-visible lazy load.
        tutorialModulePromise = null;
        throw error;
      });
  }
  return tutorialModulePromise;
}

// Keep the tutorial — its components AND the two embedded word-map artifacts — out of the
// startup bundle: most sessions never render it (a screen most players see once), but the
// invitation preloads it while the first-visit player reads the question, so accepting still
// opens without a network pause. Same shape as LazyStreakDialog, the app's precedent.
export function preloadTutorial(): void {
  void loadTutorial().catch(() => {
    // The lazy render retries; a speculative preload failure is intentionally silent.
  });
}

export default function LazyTutorial(props: TutorialProps) {
  const [Loaded, setLoaded] = useState<TutorialComponent | null>(() => loadedTutorial);

  useEffect(() => {
    if (Loaded) return undefined;
    let cancelled = false;
    loadTutorial()
      .then((component) => {
        if (!cancelled) setLoaded(() => component);
      })
      .catch(() => {
        // A lost chunk must never strand the player on a blank screen: skip the lesson and
        // land in the game — the header's "?" remains the way back once the network does.
        if (!cancelled) props.onDone();
      });
    return () => {
      cancelled = true;
    };
  }, [Loaded, props.onDone]);

  // The cold path (replay, ?tutorial=1) briefly shows the app's plain loading line; the
  // first-visit path is warm from the invitation's preload.
  return Loaded ? <Loaded {...props} /> : <p className="status">{t(props.lang, 'loading')}</p>;
}
