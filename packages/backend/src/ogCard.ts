// Share-card rendering (issue #8): rasterize the shared card SVG to a PNG for the OG image,
// and build the tiny HTML page that carries the OG meta + redirects a human into the game.
// The SVG/layout + heat colors come from @whippin/shared (renderCardSvg), so the card matches
// the on-screen grid exactly; here we only add the pixel font + rasterization.
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { renderCardSvg, type CardData, type ShareResult, CARD_WIDTH, CARD_HEIGHT } from '@whippin/shared';

// Bundled Press Start 2P (OFL), so the card's text matches the app's pixel font.
const FONT_PATH = fileURLToPath(new URL('../assets/PressStart2P-Regular.ttf', import.meta.url));
const CARD_FONT = 'Press Start 2P';

export function renderCardPng(data: CardData): Buffer {
  const resvg = new Resvg(renderCardSvg(data), {
    font: { fontFiles: [FONT_PATH], loadSystemFonts: false, defaultFontFamily: CARD_FONT },
  });
  return Buffer.from(resvg.render().asPng());
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// The share page: OG/Twitter meta pointing at /og/<token>.png so the link unfurls into the
// card, plus a redirect so a human who clicks it lands on the game. `base` is the request's
// own origin (same host serves /og and the SPA), so the URLs are absolute as crawlers need.
export function renderShareHtml(token: string, result: ShareResult, base: string): string {
  const lang = /^[a-z]{2}$/.test(result.lang) ? result.lang : 'en'; // sanitize (token-sourced)
  const title = escapeAttr(`Whippin AI #${result.dayNumber} — SCORE ${result.score}`);
  const image = escapeAttr(`${base}/og/${token}.png`);
  const game = escapeAttr(`${base}/${lang}`);
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
<meta http-equiv="refresh" content="0; url=${game}">
</head>
<body>
<p>Redirecting to <a href="${game}">Whippin AI</a>…</p>
</body>
</html>`;
}
