import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer, defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
// Lets `import Icon from './x.svg?react'` return an inline React component (see AGENTS.md
// "SVG icons"): the SVG is emitted into the DOM, so its `fill="currentColor"` inherits the
// button's `color` for every theme/state instead of being locked to a rasterised <img>.
import svgr from 'vite-plugin-svgr';
import type { LinkPreview } from './src/linkPreviews';

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

// THE LINK PREVIEWS (src/linkPreviews.ts): the shell's placeholder takes the HOME preview, and
// every page with a preview of its own is the same shell again under its route
// (`fr/learn/2/index.html`), wearing its own block and its language. The pictures go out as
// hashed assets — a redrawn one is a new URL, which is what makes a chat app read it again.
// A missing picture or placeholder fails the build: a page shipping the wrong card, or none,
// is only ever seen in somebody else's chat.
//
// The previews are read off the app's own modules, which reach @whippin/shared — TS source
// this config file cannot import (Vite hands a config's package imports to Node). So the
// plugin loads `src/linkPreviews.ts` THROUGH Vite, as the app itself is built.
const PREVIEW_SLOT = '<!-- link-preview -->';
const SHELL_LANG = '<html lang="en"';
type Previews = typeof import('./src/linkPreviews');

function linkPreviews(): Plugin {
  let previews: Previews;
  return {
    name: 'link-previews',
    apply: 'build',
    enforce: 'post',
    async buildStart() {
      const server = await createServer({
        configFile: false,
        root: fileURLToPath(new URL('.', import.meta.url)),
        logLevel: 'silent',
        appType: 'custom',
        // No HMR and no WebSocket server: `hmr: false` alone still binds Vite's HMR port.
        server: { middlewareMode: true, hmr: false, ws: false },
        optimizeDeps: { noDiscovery: true, include: [] },
      });
      try {
        previews = (await server.ssrLoadModule('/src/linkPreviews.ts')) as Previews;
      } finally {
        await server.close();
      }
    },
    generateBundle(_options, bundle) {
      const index = bundle['index.html'];
      if (index?.type !== 'asset') throw new Error('link-previews: no index.html in the bundle');
      const shell = String(index.source);
      if (shell.split(PREVIEW_SLOT).length !== 2 || shell.split(SHELL_LANG).length !== 2) {
        throw new Error(`link-previews: index.html must carry ${PREVIEW_SLOT} and ${SHELL_LANG} once each`);
      }
      const page = (preview: LinkPreview) => {
        const ref = this.emitFile({
          type: 'asset',
          name: preview.image,
          source: readFileSync(new URL(`./src/assets/previews/${preview.image}`, import.meta.url)),
        });
        const tags = previews.previewTags(preview, `${previews.SITE_ORIGIN}/${this.getFileName(ref)}`);
        return shell.replace(PREVIEW_SLOT, tags).replace(SHELL_LANG, `<html lang="${preview.lang}"`);
      };
      index.source = page(previews.HOME_PREVIEW);
      for (const preview of previews.pagePreviews()) {
        this.emitFile({ type: 'asset', fileName: `${preview.path.slice(1)}/index.html`, source: page(preview) });
      }
    },
  };
}

// THE FIRST SCREEN'S TWO FACES, asked for with the document: the pixel face and the chrome
// face's latin subset (`src/index.css` @font-face) are otherwise requested only once the
// stylesheet has been parsed and a glyph needs them, so the first frames set the header in a
// fallback face and the type jumps when they land. `font-display` stays `swap` — a face held
// back by `block` would hide the sentence for as long as the network takes. The build names
// each file by its hash; the dev server serves the source path the stylesheet asks for.
const FIRST_FACES = ['PressStart2P.woff2', 'azeret-mono-latin.woff2'];

function preloadFirstFaces(): Plugin {
  return {
    name: 'preload-first-faces',
    transformIndexHtml: {
      order: 'post',
      handler(_html, { bundle }) {
        return FIRST_FACES.map((face) => {
          let href = `/src/assets/fonts/${face}`;
          if (bundle) {
            const asset = Object.values(bundle).find(
              (file) => file.type === 'asset' && file.names.includes(face),
            );
            if (!asset) throw new Error(`preload-first-faces: ${face} is not in the bundle`);
            href = `/${asset.fileName}`;
          }
          return {
            tag: 'link',
            attrs: { rel: 'preload', href, as: 'font', type: 'font/woff2', crossorigin: '' },
            injectTo: 'head',
          };
        });
      },
    },
  };
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
      preloadFirstFaces(),
      linkPreviews(),
    ],
    define: { __BUILD_ID__: JSON.stringify(build) },
    // THE CDN'S OWN PATH LIST, restated for local development. In production the WEB
    // distribution hands these three patterns to the API origin instead of the bucket
    // (infra/lib/web-stack.ts `additionalBehaviors`): `/s/*` the share page, `/og/*`
    // every card image, and `/g/*` #271's group invite link, which the backend renders so
    // it unfurls in a chat as the group's name and its members' marks.
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
    // (`'^/g/': apiBase`) does NOT leave them off — measured: the invite page came back
    // redirecting to `http://localhost:8787/join/…`, the backend rather than the app,
    // which is a dead end wearing a working page's clothes. Hence the explicit object.
    server: apiBase
      ? {
          proxy: Object.fromEntries(
            ['^/g/', '^/s/', '^/og/'].map((pattern) => [
              pattern,
              { target: apiBase, changeOrigin: false, xfwd: false },
            ]),
          ),
        }
      : undefined,
  };
});
