import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initAnalytics } from './analytics';
import { installButtonFocusGuard } from './buttonFocus';
import { loadDeviceIdentity } from './identity';
import { installGameStoreSync, reconcileGameStateIdentity } from './state/gameStore';
import { installIdentityScope } from './state/identityScope';
import { installVersionCheck } from './versionCheck';
import './index.css';

const removeButtonFocusGuard = installButtonFocusGuard();
if (import.meta.hot) import.meta.hot.dispose(removeButtonFocusGuard);

// This device's identity (#216), adopted BEFORE React renders: every private read branches
// on whether one exists, and a read that fired against a not-yet-loaded identity would ask
// the server about nobody. It creates nothing — a visit that performs none of the
// deliberate acts mints no token and no server row.
const loadedIdentity = loadDeviceIdentity();
// The device key and the persisted game blob are separate localStorage records. Reconcile
// them before any route can see the outbox: only a matching owner — or the pending token of
// the deliberate act that created ownerless state — may carry it across this reload.
reconcileGameStateIdentity(loadedIdentity.identity, loadedIdentity.pending);
const removeIdentityScope = installIdentityScope();
if (import.meta.hot) import.meta.hot.dispose(removeIdentityScope);
// The game blob's cross-tab half (PR-219 review, P1): adopt a sibling tab's persisted
// write before this tab's next own one, or a stale tab's next set — the identity
// adoption's owner tag included — overwrites the active tab's unsent guesses.
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
