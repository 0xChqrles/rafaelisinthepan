import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initAnalytics } from './analytics';
import './index.css';

// Env-gated (VITE_PLAUSIBLE_DOMAIN): a no-op unless the production deploy configured it.
initAnalytics();

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
