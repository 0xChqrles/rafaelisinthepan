import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
// @rafaelisinthepan/shared is a linked workspace package; Vite resolves it via its
// package.json "exports" to TS source and transpiles it as part of the app.
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiBase = env.VITE_API_BASE_URL?.trim();
  if (mode !== 'test' && (command === 'serve' || command === 'build') && !apiBase) {
    throw new Error(
      'VITE_API_BASE_URL is required. Set it to the backend URL, e.g. http://localhost:8787.',
    );
  }

  return {
    plugins: [react()],
  };
});
