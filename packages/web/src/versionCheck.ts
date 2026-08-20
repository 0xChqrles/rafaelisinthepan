// Stale-tab detection: an SPA loads its JS once, so a release never reaches a tab that
// stays open — and the web deploy deliberately keeps old hashed chunks around
// (`prune: false`), so nothing ever breaks a stale tab into refreshing. This module is
// the missing signal: the bundle knows the build it was compiled from (`__BUILD_ID__`)
// and `/version.json` names the build currently deployed, both stamped by
// vite.config.ts from the same value. When they disagree the tab reloads — index.html
// is served no-cache and deploys invalidate `/*`, so a reload always lands on the new
// build, and round state is persisted, so it loses nothing.
//
// WHEN matters more than how often. A reload must never yank a visibly active player,
// so it is spent only where nothing is at stake: the page's own STARTUP, returning to a
// dormant page (the stale bundle is about to talk to the backend again, and the player
// has not re-engaged yet) or while the tab is hidden (a reload nobody can see). BOTH
// visibility flips check — backgrounding right after a deploy is the commonest hidden
// window — and a `persisted` pageshow is the same return in the other shape: a bfcache
// restore hands back the LIVE page with no network at all, so the old bundle simply
// resumes, and WebKit does not reliably flip visibility for it. The hourly interval is
// the backstop for a page that never returns at all: it swaps a hidden tab on the spot,
// and for a visible one it only raises the flag for the next return to spend. Every
// failure is silent: offline or a mid-deploy hiccup just waits for the next trigger.
//
// STARTUP catches the tab that came up stale rather than one that went stale, and
// nothing else here can: `no-cache` means "revalidate before reusing", not "never
// reuse", so a history navigation and a session restore both serve a stored index.html
// without asking, and a revalidation that FAILS (offline, a captive portal) may serve it
// too. Such a visit is already running the old bundle at first paint, and every other
// trigger in this module is a RETURN it may never make — it would otherwise spend its
// whole session on the old build. It is also the cheapest reload the module can spend:
// nothing typed, nothing in flight.

const VERSION_URL = '/version.json';
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
// A request that neither resolves nor errors must not strand the in-flight promise
// forever — every later trigger would join it and the checker would be dead for the
// session (the turnstile.ts script-load rule). The abort rejects into the same silent
// catch as any other failure, so the next trigger retries. Hand-rolled controller +
// timer, NOT AbortSignal.timeout(): that is Baseline 2024, above Vite 5's browser floor
// (Chrome 87 / Firefox 78 / Safari 14), and there the missing API would throw before
// fetch ever ran — silently disabling the checker on exactly those browsers.
const FETCH_TIMEOUT_MS = 10_000;
const STARTUP_RELOAD_KEY = 'whippin-version-reload';

// The `sessionStorage` PROPERTY itself throws when storage is disabled (identity.ts's
// rule), so the read needs its own catch rather than the caller's.
function sessionStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

// ONE startup reload per build, per tab. A reload revalidates the document, so a stale
// load resolves in a single swap — but a version.json briefly AHEAD of the index it
// names (a deploy's own upload window) would otherwise reload the same build over and
// over, with no player action to break the spin. Remembering the build we jumped away
// from bounds that to one wasted reload, and the returns still carry the mismatch
// afterwards. Storage that cannot be written cannot bound it, so there the startup
// reload is not spent at all.
function claimStartupReload(current: string): boolean {
  const store = sessionStore();
  if (!store) return false;
  try {
    if (store.getItem(STARTUP_RELOAD_KEY) === current) return false;
    store.setItem(STARTUP_RELOAD_KEY, current);
  } catch {
    return false;
  }
  return true;
}

export function installVersionCheck(current: string = __BUILD_ID__): void {
  let stale = false;
  let inFlight: Promise<void> | null = null;

  const check = (): Promise<void> => {
    if (stale) return Promise.resolve();
    inFlight ??= (async () => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(VERSION_URL, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!res.ok) return;
        const body = (await res.json()) as { build?: unknown };
        if (typeof body.build === 'string' && body.build !== current) stale = true;
      } catch {
        // Offline, or the file mid-swap during a deploy: the next trigger retries.
      } finally {
        window.clearTimeout(timeout);
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const reloadIfStale = () => {
    if (stale) location.reload();
  };

  // Visible tabs keep playing on the old build until a return; a tab that is still
  // hidden when the check resolves swaps now (one that returned meanwhile belongs to the
  // resumed path, which runs its own check).
  const checkThenSwapHidden = () =>
    void check().then(() => {
      if (document.visibilityState === 'hidden') reloadIfStale();
    });

  // Coming back to a page that was left: spend any flag an earlier check raised, then
  // ask again.
  const resume = () => {
    reloadIfStale();
    void check().then(reloadIfStale);
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resume();
    else {
      // Backgrounding may also spend a flag an earlier check already raised.
      reloadIfStale();
      checkThenSwapHidden();
    }
  });

  // `persisted` is exactly "this document was resumed, not re-fetched" — the bfcache
  // restore the visibility flip may not report.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) resume();
  });

  window.setInterval(checkThenSwapHidden, CHECK_INTERVAL_MS);

  void check().then(() => {
    if (stale && claimStartupReload(current)) location.reload();
  });
}
