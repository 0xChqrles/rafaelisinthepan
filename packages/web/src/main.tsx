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
  // mutation before a route can see or send an outbox.
  reconcileGameStateIdentity(loadedIdentity.identity, loadedIdentity.pending);
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

void mount();
