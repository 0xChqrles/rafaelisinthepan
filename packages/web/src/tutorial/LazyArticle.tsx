import { useEffect, useState } from 'react';
import type { ComponentProps, ComponentType } from 'react';
import type ArticleLevel from './ArticleLevel';
import { t } from '../i18n';
import LoadingWave from '../components/LoadingWave';

type ArticleProps = ComponentProps<typeof ArticleLevel>;
type ArticleComponent = ComponentType<ArticleProps>;

let loaded: ArticleComponent | null = null;
let modulePromise: Promise<ArticleComponent> | null = null;

function load() {
  if (!modulePromise) {
    modulePromise = import('./ArticleLevel')
      .then((module) => {
        loaded = module.default;
        return loaded;
      })
      .catch((error) => {
        // A failed load must not poison the next attempt.
        modulePromise = null;
        throw error;
      });
  }
  return modulePromise;
}

// Keep the article levels — their prose, figures and the board they quote — out of the
// startup bundle: LazyLevelOne's shape. A lost chunk hands the reader back (`onUnavailable`).
export default function LazyArticle({ onUnavailable, ...props }: ArticleProps & { onUnavailable: () => void }) {
  const [Loaded, setLoaded] = useState<ArticleComponent | null>(() => loaded);

  useEffect(() => {
    if (Loaded) return undefined;
    let cancelled = false;
    load()
      .then((component) => {
        if (!cancelled) setLoaded(() => component);
      })
      .catch(() => {
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
