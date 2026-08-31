import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initAnalytics } from './analytics';
import { installButtonFocusGuard } from './buttonFocus';
import { loadDeviceIdentity } from './identity';
import {
  flushGameStorePersistence,
  hydrateGameStore,
  installGameStoreSync,
  reconcileGameStateIdentity,
} from './state/gameStore';
import { installIdentityScope } from './state/identityScope';
import { installLocalIdentityDeploy } from './state/localIdentityDeploy';
import { installVersionCheck } from './versionCheck';
import { installTheme } from './theme';
import './index.css';

installTheme();

const removeButtonFocusGuard = installButtonFocusGuard();
if (import.meta.hot) import.meta.hot.dispose(removeButtonFocusGuard);

// First paint is gated on IndexedDB, and an `indexedDB.open()` can STALL rather than
// reject — a future schema upgrade blocked by a frozen background tab whose `blocking`
// handler never runs, a WebKit stall after a bfcache restore. `mount().catch` only fires
// on REJECTION, so without a deadline a stall is a permanently blank page with nothing in
// the console. The timeout turns it into the visible failure below; generous, because it
// only ever fires on a startup that was never going to finish.
const STARTUP_STEP_TIMEOUT_MS = 10_000;
function withStartupDeadline<T>(work: Promise<T>, step: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Startup timed out: ${step}.`)),
        STARTUP_STEP_TIMEOUT_MS,
      );
      // The race won normally: do not keep a timer holding the process (tests) alive.
      work.finally(() => clearTimeout(timer)).catch(() => {});
    }),
  ]);
}

async function mount(): Promise<void> {
  // This device's identity (#216), adopted BEFORE React renders: every private read branches
  // on whether one exists, and a read that fired against a not-yet-loaded identity would ask
  // the server about nobody. It creates nothing — a visit that performs none of the
  // deliberate acts mints no token and no server row.
  loadDeviceIdentity();
  // Hydration is asynchronous now because the game state lives behind IndexedDB's atomic
  // transaction boundary. No route mounts between defaults and the committed state.
  await withStartupDeadline(hydrateGameStore(), 'game state hydration');
  // Hydration yields to the event loop. Install the live scope before re-reading the shared
  // identity key, so an account transition during that wait cannot fall between startup's
  // one reconciliation and the listener that owns every later one.
  const removeIdentityScope = installIdentityScope();
  if (import.meta.hot) import.meta.hot.dispose(removeIdentityScope);
  // Beside the scope and for the same reason: the locally-decided username is deployed off
  // the identity lifecycle, not at each of the five deploy triggers, so a future trigger
  // cannot forget it. Installed in the same breath, before the shared key is re-read.
  const removeLocalIdentityDeploy = installLocalIdentityDeploy();
  if (import.meta.hot) import.meta.hot.dispose(removeLocalIdentityDeploy);
  const loadedIdentity = loadDeviceIdentity();
  // Reconcile the identity against the LATEST committed state, then wait for that ownership
  // mutation before a route can see or send an outbox. UNLESS the shared key could not be
  // read at all: an unreadable storage says nothing about this device's identity
  // (identity.ts's own rule), so its null is not proven emptiness — reconciling it would
  // wipe the outbox and the Word rounds out of an intact database. Skipping leaves the
  // committed owner standing; every live transition still reconciles through the scope
  // listener above, off identities it actually proved.
  if (loadedIdentity.readable) {
    reconcileGameStateIdentity(loadedIdentity.identity, loadedIdentity.pending);
  }
  await withStartupDeadline(flushGameStorePersistence(), 'persisting the game state');

  const removeGameStoreSync = installGameStoreSync();
  if (import.meta.hot) import.meta.hot.dispose(removeGameStoreSync);

  // Env-gated (VITE_PLAUSIBLE_DOMAIN): a no-op unless the production deploy configured it.
  initAnalytics();

  // Prod only: dev serves no version.json, and HMR already delivers new code to open tabs.
  if (import.meta.env.PROD) installVersionCheck();

  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

mount().catch((error: unknown) => {
  // A startup that died must SAY so: `mount` is asynchronous, so an uncaught rejection
  // anywhere in it (a persistence blob a newer build wrote, an IndexedDB fallback that
  // itself failed) is otherwise a permanently blank page with nothing in the console's
  // place. Plain DOM, because React never mounted — and unlocalized, because the language
  // preference lives behind the very store that may be what failed. Reloading is the one
  // action that can help.
  console.error('Failed to start the app', error);
  const root = document.getElementById('root');
  if (root !== null && root.childElementCount === 0) {
    const message = document.createElement('p');
    message.textContent = 'SOMETHING WENT WRONG — RELOAD TO TRY AGAIN';
    message.setAttribute('style', 'margin: 40vh auto 0; padding: 0 24px; text-align: center;');
    root.append(message);
  }
});
