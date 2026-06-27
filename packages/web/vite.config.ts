import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
// @word-hunt/shared is a linked workspace package; Vite resolves it via its
// package.json "exports" to TS source and transpiles it as part of the app.
export default defineConfig({
  plugins: [react()],
});
