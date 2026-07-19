import { useEffect, useState } from 'react';

// Minimal client-side navigation for the static SPA (no router dependency, no backend
// changes). pushState/replaceState do NOT emit `popstate`, so programmatic navigation
// notifies subscribers explicitly; the browser's own back/forward still arrive via
// `popstate`. Both paths funnel through `useLocation`, which re-reads the pathname.

type Listener = () => void;
const listeners = new Set<Listener>();

// Navigate to `path`, preserving the current query string (so dev harnesses like
// ?tutorial=1 / ?streak= survive route changes). `replace` swaps the current history
// entry instead of pushing — used for the `/` -> /<lang> redirect so `/` never sits in
// history and back from the game exits rather than bouncing through the redirect.
export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  const url = path + window.location.search;
  if (opts.replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  for (const l of listeners) l();
}

function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

// The current pathname, kept in sync with both programmatic navigate() and the
// browser's back/forward (popstate). Re-render on change.
export function useLocation(): string {
  const [pathname, setPathname] = useState<string>(() => window.location.pathname);
  useEffect(() => {
    const sync = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', sync);
    const off = subscribe(sync);
    return () => {
      window.removeEventListener('popstate', sync);
      off();
    };
  }, []);
  return pathname;
}
