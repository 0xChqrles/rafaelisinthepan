import { useEffect, useState } from 'react';
import type { ComponentType } from 'react';

// ONE COMPONENT KEPT OUT OF THE STARTUP BUNDLE: fetched the first time it is rendered, or
// ahead of that by `preload`, and held for the session once it has arrived. `React.lazy` is
// not a substitute — it caches a rejected import; here a lost chunk is asked for again by the
// next caller. (The BROWSER may still answer from its own module map: a document keeps a
// module it failed to fetch failed — measured on Chromium 151 and WebKit 26.5, a second
// `import()` of the chunk rejects without a request — which is why a user's RETRY is a new
// document, below.)
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
    // Speculative: the lazy render asks again, so a failure here is intentionally silent.
    preload(): void {
      void load().catch(() => {});
    },
    // The component once it is here (null until then), and whether the load was LOST: what
    // to show instead of stranding the screen is the caller's to say — and its RETRY, which
    // RELOADS the page where it stands: the document holds the lost module failed, so only a
    // new one can fetch it.
    useLoaded(): { Loaded: ComponentType<P> | null; failed: boolean; retry: () => void } {
      const [Loaded, setLoaded] = useState<ComponentType<P> | null>(() => loaded);
      const [failed, setFailed] = useState(false);

      useEffect(() => {
        if (Loaded) return undefined;
        let cancelled = false;
        load()
          .then((component) => {
            if (!cancelled) setLoaded(() => component);
          })
          .catch(() => {
            if (!cancelled) setFailed(true);
          });
        return () => {
          cancelled = true;
        };
      }, [Loaded]);

      return { Loaded, failed, retry: reloadPage };
    },
  };
}

const reloadPage = () => window.location.reload();
