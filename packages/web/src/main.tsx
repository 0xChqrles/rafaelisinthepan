import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initAnalytics } from './analytics';
import { installButtonFocusGuard } from './buttonFocus';
import { loadDeviceIdentity } from './identity';
import { installIdentityScope } from './state/identityScope';
import { installVersionCheck } from './versionCheck';
import './index.css';

const removeButtonFocusGuard = installButtonFocusGuard();
if (import.meta.hot) import.meta.hot.dispose(removeButtonFocusGuard);

// This device's identity (#216), adopted BEFORE React renders: every private read branches
// on whether one exists, and a read that fired against a not-yet-loaded identity would ask
// the server about nobody. It creates nothing — a visit that performs none of the
// deliberate acts mints no token and no server row.
loadDeviceIdentity();
const removeIdentityScope = installIdentityScope();
if (import.meta.hot) import.meta.hot.dispose(removeIdentityScope);

// Env-gated (VITE_PLAUSIBLE_DOMAIN): a no-op unless the production deploy configured it.
initAnalytics();

// Prod only: dev serves no version.json, and HMR already delivers new code to open tabs.
if (import.meta.env.PROD) installVersionCheck();

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
