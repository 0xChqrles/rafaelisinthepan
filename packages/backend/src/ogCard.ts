// Share-card rendering (issue #8): rasterize the shared card SVG to a PNG for the OG image,
// and build the tiny HTML page that carries the OG meta + redirects a human into the game.
// The SVG/layout + heat colors come from @whippin/shared (renderCardSvg), so the card matches
// the on-screen grid exactly; here we only add the pixel font + rasterization.
//
// resvg runs as WebAssembly (@resvg/resvg-wasm) — no native .node addon, so it bundles with
// esbuild and deploys to Lambda without Docker or an arch-specific binary. The .wasm module
// and the pixel font live in ./assets NEXT TO this module and are copied into the Lambda
// bundle at synth (backend-stack commandHooks), so the SAME `./assets/*` paths resolve both
// locally (tsx/vitest) and in the deployed bundle (index.mjs at the bundle root).
import { readFile } from 'node:fs/promises';
import { Resvg, initWasm } from '@resvg/resvg-wasm';
import { renderCardSvg, type CardData, type ShareResult, CARD_WIDTH, CARD_HEIGHT } from '@whippin/shared';

const WASM_URL = new URL('./assets/resvg.wasm', import.meta.url);
const FONT_URL = new URL('./assets/PressStart2P-Regular.ttf', import.meta.url);
const CARD_FONT = 'Press Start 2P';

// initWasm may be called only ONCE per process, so init on first render and cache the promise
// (which also yields the reusable font buffer). NB: if @resvg/resvg-wasm is bumped, refresh
// the committed src/assets/resvg.wasm to match the JS glue.
let ready: Promise<Uint8Array> | null = null;
function ensureReady(): Promise<Uint8Array> {
  if (!ready) {
    ready = (async () => {
      await initWasm(new Uint8Array(await readFile(WASM_URL)));
      return new Uint8Array(await readFile(FONT_URL));
    })();
  }
  return ready;
}

export async function renderCardPng(data: CardData): Promise<Buffer> {
  const font = await ensureReady();
  const resvg = new Resvg(renderCardSvg(data), {
    font: { fontBuffers: [font], loadSystemFonts: false, defaultFontFamily: CARD_FONT },
  });
  return Buffer.from(resvg.render().asPng());
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// The share page: OG/Twitter meta pointing at /og/<token>.png so the link unfurls into the
// card, plus a redirect so a human who clicks it lands on the game. `base` is the canonical
// site origin (the apex), so the URLs are absolute as crawlers need.
//
// The redirect is JavaScript, NOT `<meta http-equiv="refresh">`: preview crawlers don't run
// JS, so they stop here and read THIS page's card OG tags. A meta-refresh, by contrast, is
// followed by some crawlers (e.g. Telegram) to the game page, whose default OG tags then
// win — showing the wrong preview. Humans (who run JS) still get bounced to the game; the
// visible link is the no-JS fallback.
export function renderShareHtml(token: string, result: ShareResult, base: string): string {
  const lang = /^[a-z]{2}$/.test(result.lang) ? result.lang : 'en'; // sanitize (token-sourced)
  const title = escapeAttr(`Whippin AI #${result.dayNumber} — SCORE ${result.score}`);
  const image = escapeAttr(`${base}/og/${token}.png`);
  const gameUrl = `${base}/${lang}`; // safe: base is server-set, lang is /^[a-z]{2}$/
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="${CARD_WIDTH}">
<meta property="og:image:height" content="${CARD_HEIGHT}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:image" content="${image}">
</head>
<body>
<p>Redirecting to <a href="${escapeAttr(gameUrl)}">Whippin AI</a>…</p>
<script>location.replace(${JSON.stringify(gameUrl)})</script>
</body>
</html>`;
}
