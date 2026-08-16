import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
// Lets `import Icon from './x.svg?react'` return an inline React component (see AGENTS.md
// "SVG icons"): the SVG is emitted into the DOM, so its `fill="currentColor"` inherits the
// button's `color` for every theme/state instead of being locked to a rasterised <img>.
import svgr from 'vite-plugin-svgr';

// https://vite.dev/config/
// @whippin/shared is a linked workspace package; Vite resolves it via its
// package.json "exports" to TS source and transpiles it as part of the app.
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiBase = env.VITE_API_BASE_URL?.trim();
  if (mode !== 'test' && (command === 'serve' || command === 'build') && !apiBase) {
    throw new Error(
      'VITE_API_BASE_URL is required. Set it to the backend URL, e.g. http://localhost:8787.',
    );
  }
  const turnstileSiteKey = env.VITE_TURNSTILE_SITE_KEY?.trim();
  if (command === 'build' && mode === 'production' && !turnstileSiteKey) {
    throw new Error(
      'VITE_TURNSTILE_SITE_KEY is required for production builds; refusing to ship score collection disabled.',
    );
  }

  return {
    // svgr before react so `?react` SVG imports are transformed into components first.
    plugins: [svgr(), react()],
  };
});
