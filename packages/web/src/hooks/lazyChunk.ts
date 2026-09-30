import { useEffect, useState } from 'react';
import type { ComponentType } from 'react';

// ONE COMPONENT KEPT OUT OF THE STARTUP BUNDLE: fetched the first time it is rendered, or
// ahead of that by `preload`, and held for the session once it has arrived. `React.lazy` is
// not a substitute — it caches a rejected import, and a failed idle preload must not poison
// the later user-visible load: a lost chunk is asked for again by the next caller.
export function lazyChunk<P>(importer: () => Promise<{ default: ComponentType<P> }>) {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;

  function load(): Promise<ComponentType<P>> {
    if (!pending) {
      pending = importer()
        .then((module) => {
          loaded = module.default;
          return module.default;
        })
        .catch((error) => {
          pending = null;
          throw error;
        });
    }
    return pending;
  }

  return {
    // Speculative: the lazy render retries, so a failure here is intentionally silent.
    preload(): void {
      void load().catch(() => {});
    },
    // The component once it is here, null until then. A load that is lost calls `onFail`:
    // what to do instead of stranding the screen is the caller's to say.
    useLoaded(onFail: () => void): ComponentType<P> | null {
      const [Loaded, setLoaded] = useState<ComponentType<P> | null>(() => loaded);

      useEffect(() => {
        if (Loaded) return undefined;
        let cancelled = false;
        load()
          .then((component) => {
            if (!cancelled) setLoaded(() => component);
          })
          .catch(() => {
            if (!cancelled) onFail();
          });
        return () => {
          cancelled = true;
        };
      }, [Loaded, onFail]);

      return Loaded;
    },
  };
}
