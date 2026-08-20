import { execSync } from 'node:child_process';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
// Lets `import Icon from './x.svg?react'` return an inline React component (see AGENTS.md
// "SVG icons"): the SVG is emitted into the DOM, so its `fill="currentColor"` inherits the
// button's `color` for every theme/state instead of being locked to a rasterised <img>.
import svgr from 'vite-plugin-svgr';

// The build's identity, for stale-tab detection (src/versionCheck.ts): the bundle carries
// it as `__BUILD_ID__` and the emitted `dist/version.json` names the same value — so an
// open tab can ask whether its build is still the deployed one. PER-BUILD, not the git
// commit alone: the commit under-identifies a bundle (a same-SHA redeploy with a rotated
// VITE_ variable is a different bundle under the same id, and its stale tabs would never
// refresh). The commit stays in the id for human debuggability; the timestamp is what
// makes it a build's. The cost — a redeploy of byte-identical code reloads open tabs
// once, losslessly, at a safe moment — is accepted for an id with nothing to maintain.
function buildId(): string {
  const stamp = Date.now().toString(36);
  try {
    const sha = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return `${sha}-${stamp}`;
  } catch {
    return `local-${stamp}`;
  }
}

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

  const build = buildId();
  return {
    // svgr before react so `?react` SVG imports are transformed into components first.
    plugins: [
      svgr(),
      react(),
      {
        // version.json lands in the unhashed root set the web deploy serves no-cache
        // (infra DeployRoot), so a stale tab's fetch always sees the deployed build.
        name: 'emit-version-json',
        apply: 'build',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'version.json',
            source: JSON.stringify({ build }),
          });
        },
      },
    ],
    define: { __BUILD_ID__: JSON.stringify(build) },
    // THE CDN'S OWN PATH LIST, restated for local development. In production the WEB
    // distribution hands these three patterns to the API origin instead of the bucket
    // (infra/lib/web-stack.ts `additionalBehaviors`): `/s/*` the share page, `/og/*`
    // every card image, and `/i/*` #189's invite link, which the backend renders so it
    // unfurls in a chat as the sender's own mark and name.
    //
    // Without this the dev server's SPA fallback answers them with index.html and the
    // app's router sees a path it no longer owns — a pasted invite link silently lands
    // on the game with no edge recorded, which is exactly what it looked like
    // (user-reported 2026-08-20). Keep this list in step with the behaviors there; a
    // pattern added on one side and not the other is a route that works in exactly one
    // of the two environments.
    //
    // `changeOrigin` and `xfwd` are pinned OFF, and that is the load-bearing half.
    // With no siteOrigin configured the backend builds its redirect and its og:image
    // URLs from the REQUEST's Host, so forwarding the browser's own Host is what makes
    // those absolute URLs point back at this dev server. Vite's string shorthand
    // (`'^/i/': apiBase`) does NOT leave them off — measured: the invite page came back
    // redirecting to `http://localhost:8787/join/…`, the backend rather than the app,
    // which is a dead end wearing a working page's clothes. Hence the explicit object.
    server: apiBase
      ? {
          proxy: Object.fromEntries(
            ['^/i/', '^/s/', '^/og/'].map((pattern) => [
              pattern,
              { target: apiBase, changeOrigin: false, xfwd: false },
            ]),
          ),
        }
      : undefined,
  };
});
