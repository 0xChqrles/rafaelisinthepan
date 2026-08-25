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
import { installVersionCheck } from './versionCheck';
import './index.css';

const removeButtonFocusGuard = installButtonFocusGuard();
if (import.meta.hot) import.meta.hot.dispose(removeButtonFocusGuard);

async function mount(): Promise<void> {
  // This device's identity (#216), adopted BEFORE React renders: every private read branches
  // on whether one exists, and a read that fired against a not-yet-loaded identity would ask
  // the server about nobody. It creates nothing — a visit that performs none of the
  // deliberate acts mints no token and no server row.
  loadDeviceIdentity();
  // Hydration is asynchronous now because the game state lives behind IndexedDB's atomic
  // transaction boundary. No route mounts between defaults and the committed state.
  await hydrateGameStore();
  // Hydration yields to the event loop. Install the live scope before re-reading the shared
  // identity key, so an account transition during that wait cannot fall between startup's
  // one reconciliation and the listener that owns every later one.
  const removeIdentityScope = installIdentityScope();
  if (import.meta.hot) import.meta.hot.dispose(removeIdentityScope);
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
  await flushGameStorePersistence();

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
