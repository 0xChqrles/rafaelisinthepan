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
// so it is spent only on the visibility flips: returning to a dormant tab (the stale
// bundle is about to talk to the backend again, and the player has not re-engaged yet)
// or while the tab is hidden (a reload nobody can see). The hourly interval is only the
// backstop that keeps an always-visible tab's staleness bounded — it checks, flags, and
// lets the next flip spend the flag. Every failure is silent: offline or a mid-deploy
// hiccup just waits for the next trigger.

const VERSION_URL = '/version.json';
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

export function installVersionCheck(current: string = __BUILD_ID__): void {
  let stale = false;
  let inFlight: Promise<void> | null = null;

  const check = (): Promise<void> => {
    if (stale) return Promise.resolve();
    inFlight ??= (async () => {
      try {
        const res = await fetch(VERSION_URL, { cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json()) as { build?: unknown };
        if (typeof body.build === 'string' && body.build !== current) stale = true;
      } catch {
        // Offline, or the file mid-swap during a deploy: the next trigger retries.
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const reloadIfStale = () => {
    if (stale) location.reload();
  };

  document.addEventListener('visibilitychange', () => {
    // Either direction may spend a flag the interval already raised.
    reloadIfStale();
    if (document.visibilityState === 'visible') void check().then(reloadIfStale);
  });

  window.setInterval(() => {
    void check().then(() => {
      // Visible tabs keep playing on the old build until a flip; hidden ones swap now.
      if (document.visibilityState === 'hidden') reloadIfStale();
    });
  }, CHECK_INTERVAL_MS);
}
