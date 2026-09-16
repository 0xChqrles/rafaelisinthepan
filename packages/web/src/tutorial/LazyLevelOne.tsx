import { useEffect, useState } from 'react';
import type { ComponentProps, ComponentType } from 'react';
import type LevelOne from './LevelOne';
import { t } from '../i18n';
import LoadingWave from '../components/LoadingWave';

type LevelOneProps = ComponentProps<typeof LevelOne>;
type LevelOneComponent = ComponentType<LevelOneProps>;

let loaded: LevelOneComponent | null = null;
let modulePromise: Promise<LevelOneComponent> | null = null;

function load() {
  if (!modulePromise) {
    modulePromise = import('./LevelOne')
      .then((module) => {
        loaded = module.default;
        return loaded;
      })
      .catch((error) => {
        // A failed idle preload must not poison the later user-visible lazy load.
        modulePromise = null;
        throw error;
      });
  }
  return modulePromise;
}

// Keep the lesson — its components AND the embedded word maps — out of the startup bundle:
// most sessions never render it, but the invitation preloads it while the first-visit player
// reads the question, so accepting still opens without a network pause. Same shape as
// LazyStreakDialog, the app's precedent.
export function preloadLevelOne(): void {
  void load().catch(() => {
    // The lazy render retries; a speculative preload failure is intentionally silent.
  });
}

export default function LazyLevelOne({ onUnavailable, ...props }: LevelOneProps & { onUnavailable: () => void }) {
  const [Loaded, setLoaded] = useState<LevelOneComponent | null>(() => loaded);

  useEffect(() => {
    if (Loaded) return undefined;
    let cancelled = false;
    load()
      .then((component) => {
        if (!cancelled) setLoaded(() => component);
      })
      .catch(() => {
        // A lost chunk must never strand the player on a blank screen: skip the lesson and
        // land in the game — the header's book remains the way back once the network does.
        if (!cancelled) onUnavailable();
      });
    return () => {
      cancelled = true;
    };
  }, [Loaded, onUnavailable]);

  return Loaded ? (
    <Loaded {...props} />
  ) : (
    <p className="status">
      <LoadingWave text={t(props.lang, 'loading')} />
    </p>
  );
}
