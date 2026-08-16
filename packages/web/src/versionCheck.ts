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
// or while the tab is hidden (a reload nobody can see). BOTH flips check — backgrounding
// right after a deploy is the commonest hidden window. The hourly interval is the
// backstop for a tab that never flips: it swaps a hidden tab on the spot, and for a
// visible one it only raises the flag for the next flip to spend. Every failure is
// silent: offline or a mid-deploy hiccup just waits for the next trigger.

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

  // Visible tabs keep playing on the old build until a flip; a tab that is still hidden
  // when the check resolves swaps now (one that returned meanwhile belongs to the
  // visible path, which runs its own check on that flip).
  const checkThenSwapHidden = () =>
    void check().then(() => {
      if (document.visibilityState === 'hidden') reloadIfStale();
    });

  document.addEventListener('visibilitychange', () => {
    // Either direction may spend a flag an earlier check already raised.
    reloadIfStale();
    if (document.visibilityState === 'visible') void check().then(reloadIfStale);
    else checkThenSwapHidden();
  });

  window.setInterval(checkThenSwapHidden, CHECK_INTERVAL_MS);
}
