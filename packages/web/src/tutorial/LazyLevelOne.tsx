import type { ComponentProps } from 'react';
import type LevelOne from './LevelOne';
import { t } from '../i18n';
import LoadingWave from '../components/LoadingWave';
import { lazyChunk } from '../hooks/lazyChunk';

type LevelOneProps = ComponentProps<typeof LevelOne>;

// Keep the lesson — its components AND the embedded word maps — out of the startup bundle:
// most sessions never render it, but the invitation preloads it while the first-visit player
// reads the question, so accepting still opens without a network pause.
const chunk = lazyChunk<LevelOneProps>(() => import('./LevelOne'));

export function preloadLevelOne(): void {
  chunk.preload();
}

export default function LazyLevelOne({ onUnavailable, ...props }: LevelOneProps & { onUnavailable: () => void }) {
  // A lost chunk must never strand the player on a blank screen: skip the lesson and land
  // in the game — the header's book remains the way back once the network does.
  const Loaded = chunk.useLoaded(onUnavailable);

  return Loaded ? (
    <Loaded {...props} />
  ) : (
    <p className="status">
      <LoadingWave text={t(props.lang, 'loading')} />
    </p>
  );
}
