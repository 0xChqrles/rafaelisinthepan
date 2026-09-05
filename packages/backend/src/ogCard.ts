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
import {
  anonName,
  inviteCardPath,
  inviteLandingPath,
  renderCardSvg,
  renderInviteCardSvg,
  renderWordCardSvg,
  shareCardPath,
  dateForDayNumber,
  wordShareScore,
  type CardData,
  type InviteCardData,
  type ShareResult,
  type WordCardData,
  type WordShareResult,
  CARD_WIDTH,
  CARD_HEIGHT,
} from '@whippin/shared';

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

async function rasterize(svg: string): Promise<Buffer> {
  const font = await ensureReady();
  const resvg = new Resvg(svg, {
    font: { fontBuffers: [font], loadSystemFonts: false, defaultFontFamily: CARD_FONT },
  });
  return Buffer.from(resvg.render().asPng());
}

// `by` is the SIGNATURE (user-decided 2026-09-05): the player's mark and name on the
// card when the share carries their invite, nothing when it does not.
export async function renderCardPng(data: CardData, by: InviteCardData | null = null): Promise<Buffer> {
  return rasterize(renderCardSvg(data, by));
}

// Word mode's card (#156): same rasterizer, its own SVG (blue terminus + claim count + the
// per-rarity chip row + date, no ruler). The display word and the rarity breakdown travel
// in the word token, so this render stays self-contained.
export async function renderWordCardPng(
  data: WordCardData,
  by: InviteCardData | null = null,
): Promise<Buffer> {
  return rasterize(renderWordCardSvg(data, by));
}

// The #189 invite link's card: the same rasterizer, its own SVG — the player's mark,
// their name, the app name (user-decided 2026-08-20).
export async function renderInviteCardPng(data: InviteCardData): Promise<Buffer> {
  return rasterize(renderInviteCardSvg(data));
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// WHO signed a share, for the page: the id the link carries and the name the card shows
// (the STORED one, '' when never customized — the title resolves the same assigned
// pseudonym the card does, so the two halves of a preview cannot disagree).
export interface ShareSigner {
  publicId: string;
  name: string;
}

// A SIGNED share (user-decided 2026-09-05) unfurls as the player's own card and lands on
// the invite landing WITH the result, where ADD FRIEND records the edge; its title names
// the player before the score. A plain share is unchanged: the result's card, the game.
function shareTitle(result: string, by: ShareSigner | null): string {
  return by ? `${by.name || anonName(by.publicId)} · ${result}` : result;
}

function shareTarget(base: string, token: string, gameUrl: string, by: ShareSigner | null): string {
  return by ? `${base}${inviteLandingPath(by.publicId, token)}` : gameUrl;
}

// A solved sentence's share page: the card at /og/<token>.png, and a click-through into
// the day it names. `base` is the canonical site origin (the apex), so the URLs are
// absolute as crawlers need. The page template itself is `previewPage` below.
export function renderShareHtml(
  token: string,
  result: ShareResult,
  base: string,
  by: ShareSigner | null = null,
): string {
  const lang = /^[a-z]{2}$/.test(result.lang) ? result.lang : 'en'; // sanitize (token-sourced)
  // Localized by the token's language (#59). Fixed per-lang constants (never interpolated
  // input), so the title stays escape-safe. Unknown lang already normalized to 'en' above.
  const L =
    lang === 'fr'
      ? { one: 'essai', many: 'essais', play: 'Jouer à Whippin AI' }
      : { one: 'try', many: 'tries', play: 'Play Whippin AI' };
  // "N tries" (unit named), matching the card image — "SCORE" alone reads as
  // points to maximize when lower is better. The day is its CALENDAR DATE, like the card
  // draws and the click-through below addresses (decided 2026-08-03, replacing "#<index>"):
  // one day, one spelling of it everywhere a reader can see it.
  //
  // A #214 CAPPED round says `∞` where the count would be, exactly as the card draws it.
  // The literal character is right HERE where the pixel face is not involved — this is
  // ordinary HTML in the reader's own fonts; the card needs the shared path data because
  // Press Start 2P has no such glyph and the rasterizer loads nothing else.
  const count = result.capped ? '∞' : `${result.score}`;
  const title = `Whippin AI ${dateForDayNumber(result.dayNumber)} — ${count} ${
    result.capped || result.score !== 1 ? L.many : L.one
  }`;
  // Click-through lands on the SHARED day, not today (#55): the token carries the
  // puzzle's dayNumber, and past days are playable at /<lang>/<YYYY-MM-DD>, so a shared
  // ARCHIVE result opens that archived date (a shared "today" result opens today's date,
  // which the front routes identically to /<lang>). Safe: base is server-set, lang is
  // /^[a-z]{2}$/, and dateForDayNumber emits only digits + hyphens.
  const gameUrl = `${base}/${lang}/${dateForDayNumber(result.dayNumber)}`;
  return previewPage(
    lang,
    shareTitle(title, by),
    `${base}${shareCardPath(token, by?.publicId)}`,
    shareTarget(base, token, gameUrl, by),
    L.play,
  );
}

// Word mode's share page (#156): the same template, its own title ("N words" — higher is
// better here) and click-through, which lands on the shared day's WORD route so the link
// opens the daily the result belongs to.
export function renderWordShareHtml(
  token: string,
  result: WordShareResult,
  base: string,
  by: ShareSigner | null = null,
): string {
  const lang = /^[a-z]{2}$/.test(result.lang) ? result.lang : 'en'; // sanitize (token-sourced)
  const L =
    lang === 'fr'
      ? { one: 'mot', many: 'mots', play: 'Jouer à Whippin AI' }
      : { one: 'word', many: 'words', play: 'Play Whippin AI' };
  // The token stores the per-rarity breakdown; the headline's claim count is its sum.
  const score = wordShareScore(result.counts);
  const title = `Whippin AI ${dateForDayNumber(result.dayNumber)} — ${score} ${
    score === 1 ? L.one : L.many
  }`;
  const gameUrl = `${base}/${lang}/word/${dateForDayNumber(result.dayNumber)}`;
  return previewPage(
    lang,
    shareTitle(title, by),
    `${base}${shareCardPath(token, by?.publicId)}`,
    shareTarget(base, token, gameUrl, by),
    L.play,
  );
}

// The #189 invite page: `/i/<publicId>` is the link a player SHARES, so it is the page a
// chat unfurls — and what it unfurls into is that player, not the app's stock card
// (user-decided 2026-08-20). The card draws their mark and name; the TITLE says the same
// two things in text, and nothing else: no "friend invite" line, no pitch. A person sent
// this link to a person, and their own message already says what it is.
//
// Language-neutral: an invite belongs to a player, not to a daily, and the landing
// resolves the reader's own language the way `/` does. `name` is the STORED profile name
// ('' when never customized) — the card resolves the assigned identity itself, and the
// title resolves the same one so the two halves of a preview can never disagree.
export function renderInviteHtml(publicId: string, name: string, base: string): string {
  const title = `Whippin AI — ${name || anonName(publicId)}`;
  const landing = `${base}${inviteLandingPath(publicId)}`;
  return previewPage('en', title, `${base}${inviteCardPath(publicId)}`, landing, 'Whippin AI');
}

// The preview page every shared link is served as: OG/Twitter meta carrying the card,
// plus a redirect so a human who clicks lands where the link actually goes.
//
// The redirect is JavaScript, NOT `<meta http-equiv="refresh">`: preview crawlers don't
// run JS, so they stop here and read THIS page's OG tags. A meta-refresh, by contrast, is
// followed by some crawlers (e.g. Telegram) to the destination, whose default OG tags then
// win — showing the wrong preview. The redirect sits in <head> so it fires DURING head
// parsing, before the body paints, so a human never sees a "redirecting…" flash; the body
// link is the no-JS fallback. Crawlers still read the OG meta below (a <script> doesn't
// end the head).
function previewPage(
  lang: string,
  rawTitle: string,
  imageUrl: string,
  target: string,
  linkLabel: string,
): string {
  const title = escapeAttr(rawTitle);
  const image = escapeAttr(imageUrl);
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<script>location.replace(${JSON.stringify(target)})</script>
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
<body><a href="${escapeAttr(target)}">${linkLabel}</a></body>
</html>`;
}
