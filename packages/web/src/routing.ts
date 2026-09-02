import { useEffect, useState } from 'react';

// Minimal client-side navigation for the static SPA (no router dependency, no backend
// changes). pushState/replaceState do NOT emit `popstate`, so programmatic navigation
// notifies subscribers explicitly; the browser's own back/forward still arrive via
// `popstate`. Both paths funnel through `useLocation`, which re-reads the pathname.

type Listener = () => void;
const listeners = new Set<Listener>();

// The stamp every entry this app writes carries, and the only thing `goBack` trusts.
const APP_ENTRY = { app: true };

// Navigate to `path`, preserving the current query string (so dev harnesses like
// ?tutorial=1 / ?streak= survive route changes). `replace` swaps the current history
// entry instead of pushing — used for the `/` -> /<lang> redirect so `/` never sits in
// history and back from the game exits rather than bouncing through the redirect.
export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  const url = path + window.location.search;
  // The entry is STAMPED as the app's own, which is what `goBack` reads: `history.length`
  // counts the whole tab's browsing, so it cannot tell a screen this app pushed from one
  // the player reached by pasting a URL, and going back from the latter leaves the site.
  if (opts.replace) window.history.replaceState(APP_ENTRY, '', url);
  else window.history.pushState(APP_ENTRY, '', url);
  for (const l of listeners) l();
}

// LEAVE A SCREEN THE WAY IT WAS ENTERED. Most steps here return to ONE parent, so they
// simply `navigate` to it (the editor goes to `/account`, the code step to the address).
// A screen with more than one door cannot: the privacy notice is opened from `/account`
// AND from the middle of the email flow, and sending its reader to a fixed parent would
// drop somebody who was three taps into saving their account back at the start of it.
//
// So: the browser's own back where THIS app pushed the current entry (which is also the
// only case where there is something of ours behind it), and the fallback otherwise — a
// pasted or bookmarked URL has whatever came before it in that tab, and that is not ours
// to send anyone to.
export function goBack(fallback: string): void {
  if ((window.history.state as { app?: boolean } | null)?.app === true) {
    window.history.back();
    return;
  }
  navigate(fallback, { replace: true });
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
