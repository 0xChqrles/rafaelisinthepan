// Share-card rendering (issue #8): rasterize the shared card SVG to a PNG for the OG image,
// and build the tiny HTML page that carries the OG meta + redirects a human into the game.
// The SVG/layout + heat colors come from @whippin/shared (renderCardSvg), so the card matches
// the on-screen grid exactly; here we only add the fonts + rasterization.
//
// resvg runs as WebAssembly (@resvg/resvg-wasm) — no native .node addon, so it bundles with
// esbuild and deploys to Lambda without Docker or an arch-specific binary. The .wasm module
// and the fonts live in ./assets NEXT TO this module and are copied into the Lambda
// bundle at synth (backend-stack commandHooks), so the SAME `./assets/*` paths resolve both
// locally (tsx/vitest) and in the deployed bundle (index.mjs at the bundle root).
import { readFile } from 'node:fs/promises';
import { Resvg, initWasm } from '@resvg/resvg-wasm';
import {
  anonName,
  groupCardPath,
  groupInvitePath,
  groupLandingPath,
  renderCardSvg,
  renderGroupCardSvg,
  shareCardPath,
  sharePath,
  bonusPath,
  shareHeadline,
  dateForDayNumber,
  type CardData,
  type GroupCardData,
  type CardFace,
  type ShareResult,
  CARD_WIDTH,
  CARD_HEIGHT,
} from '@whippin/shared';

const WASM_URL = new URL('./assets/resvg.wasm', import.meta.url);
// The two faces a card sets: the pixel face (the count, the indices) and the chrome's mono
// in its bold (the lockup, the units, the names) — a static instance of the web's own
// variable Azeret Mono, since the rasterizer reads no woff2.
const FONT_URLS = [
  new URL('./assets/PressStart2P-Regular.ttf', import.meta.url),
  new URL('./assets/AzeretMono-Bold.ttf', import.meta.url),
];
const CARD_FONT = 'Press Start 2P';

// initWasm may be called only ONCE per process, so init on first render and cache the promise
// (which also yields the reusable font buffers). NB: if @resvg/resvg-wasm is bumped, refresh
// the committed src/assets/resvg.wasm to match the JS glue.
let ready: Promise<Uint8Array[]> | null = null;
function ensureReady(): Promise<Uint8Array[]> {
  if (!ready) {
    ready = (async () => {
      await initWasm(new Uint8Array(await readFile(WASM_URL)));
      return Promise.all(FONT_URLS.map(async (url) => new Uint8Array(await readFile(url))));
    })();
  }
  return ready;
}

async function rasterize(svg: string): Promise<Buffer> {
  const fontBuffers = await ensureReady();
  const resvg = new Resvg(svg, {
    font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: CARD_FONT },
  });
  return Buffer.from(resvg.render().asPng());
}

// `by` is the SIGNATURE (user-decided 2026-09-05): the player's mark and name on the
// card when the share is signed, nothing when it is not.
export async function renderCardPng(data: CardData, by: CardFace | null = null): Promise<Buffer> {
  return rasterize(renderCardSvg(data, by));
}

// The #271 group invite link's card: the same rasterizer, its own SVG — the group's name,
// its members' marks, the app name.
export async function renderGroupCardPng(data: GroupCardData): Promise<Buffer> {
  return rasterize(renderGroupCardSvg(data));
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// WHO signed a share, for the page: the id the link carries and the name the card shows
// (the STORED one, '' when never customized — the title resolves the same assigned
// pseudonym the card does, so the two halves of a preview cannot disagree).
export interface ShareSigner {
  publicId: string;
  name: string;
}

// A SIGNED share (user-decided 2026-09-05) unfurls as the player's own card, and its title
// names the player before the score. The click opens the shared day either way: a share
// carries no invite (2026-09-10).
function shareTitle(result: string, by: ShareSigner | null): string {
  return by ? `${by.name || anonName(by.publicId)} · ${result}` : result;
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
  // neither of the card's two faces has such a glyph and the rasterizer loads nothing else.
  const count = result.capped ? '∞' : `${result.score}`;
  const title = shareHeadline(result, count, result.capped || result.score !== 1 ? L.many : L.one);
  // Click-through lands on the SHARED day, not today (#55): the token carries the
  // puzzle's dayNumber, and past days are playable at /<lang>/<YYYY-MM-DD>, so a shared
  // ARCHIVE result opens that archived date (a shared "today" result opens today's date,
  // which the front routes identically to /<lang>). Safe: base is server-set, lang is
  // /^[a-z]{2}$/, and dateForDayNumber emits only digits + hyphens.
  //
  // A BONUS result (v7) names no day: it opens the bonus's own page (shared bonus.ts), and
  // its title and card say "BONUS <id>" where a day would say its date.
  const gameUrl =
    result.bonusId !== undefined
      ? `${base}${bonusPath(lang, result.bonusId)}`
      : `${base}/${lang}/${dateForDayNumber(result.dayNumber ?? 0)}`;
  // The page's own address: the signed link while it wears its player, the plain one when it
  // falls back to the plain share (a deleted signer) — what the page shows is that link's.
  return previewPage({
    lang,
    title: shareTitle(title, by),
    description: L.play,
    pageUrl: `${base}${sharePath(token, by?.publicId)}`,
    imageUrl: `${base}${shareCardPath(token, by?.publicId)}`,
    target: gameUrl,
    linkLabel: L.play,
  });
}

// The #271 group invite page: `/g/<groupId>` is the link a member SHARES, so it is the
// page a chat unfurls — and what it unfurls into is the group: its name over its members'
// marks. The TITLE says the name, and nothing else: no "join my group" line, no pitch. A
// person sent this link to their people, and their own message already says what it is.
//
// Language-neutral: a group belongs to its members, not to a daily, and the landing
// resolves the reader's own language the way `/` does — so the line under the title is the
// app's name alone, which reads the same in every language.
export function renderGroupHtml(groupId: string, name: string, base: string): string {
  return previewPage({
    lang: 'en',
    title: `Whippin AI — ${name}`,
    description: 'Whippin AI',
    pageUrl: `${base}${groupInvitePath(groupId)}`,
    imageUrl: `${base}${groupCardPath(groupId)}`,
    target: `${base}${groupLandingPath(groupId)}`,
    linkLabel: 'Whippin AI',
  });
}

// The preview page every shared link is served as: OG/Twitter meta carrying the card, plus a
// redirect so a human who clicks lands where the link actually goes. A chat draws the title
// over the DESCRIPTION — one short line, in the title's language (a preview without one shows
// the bare domain or nothing under the title) — and `og:url` names the page itself, the
// shared link, never the place it redirects to: an unfurler that reads it keys the preview to
// the link that was sent.
interface PreviewPage {
  lang: string;
  title: string;
  description: string;
  pageUrl: string;
  imageUrl: string;
  target: string;
  linkLabel: string;
}
function previewPage({ lang, title: rawTitle, description, pageUrl, imageUrl, target, linkLabel }: PreviewPage): string {
  const title = escapeAttr(rawTitle);
  const image = escapeAttr(imageUrl);
  return redirectPage(lang, title, target, linkLabel, [
    '<meta property="og:type" content="website">',
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${escapeAttr(description)}">`,
    `<meta property="og:url" content="${escapeAttr(pageUrl)}">`,
    `<meta property="og:image" content="${image}">`,
    `<meta property="og:image:width" content="${CARD_WIDTH}">`,
    `<meta property="og:image:height" content="${CARD_HEIGHT}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:image" content="${image}">`,
  ]);
}

// The page a DEAD link is served as — an invite naming no group, a share naming no result.
// The route answers it with a 404, so a crawler unfurls nothing (it carries no OG meta
// either, and `noindex`), while a person who clicked is moved on to `target`: the SPA
// landing, which says the invite expired, or the site home.
export function renderGoneHtml(target: string): string {
  return redirectPage('en', 'Whippin AI', target, 'Whippin AI', [
    '<meta name="robots" content="noindex">',
  ]);
}

// The shell both pages share: a redirect in <head>, a no-JS link in the body, and the
// head `meta` lines between (`title` arrives escaped).
//
// It paints the app's GROUND before anything else: the dark scheme and `--bg` / `--fg` /
// `--accent` as literals, ahead of the redirect, so a frame painted before it fires — or the
// whole page with JavaScript off — is the near-black of the app it leads to, never a white
// page with a blue link. (The web distribution's card headers allow this one inline style.)
//
// The redirect is JavaScript, NOT `<meta http-equiv="refresh">`: preview crawlers don't
// run JS, so they stop here and read THIS page's OG tags. A meta-refresh, by contrast, is
// followed by some crawlers (e.g. Telegram) to the destination, whose default OG tags then
// win — showing the wrong preview. The redirect sits in <head> so it fires DURING head
// parsing, before the body paints, so a human never sees a "redirecting…" flash; the body
// link is the no-JS fallback. Crawlers still read the OG meta below (a <script> doesn't
// end the head).
//
// The target is written into the script as a JSON string with every `<` escaped (`\u003c`,
// still `<` once the script runs): JSON alone leaves `</script>` intact, and the origin
// the target is built on can be the request's own Host.
function redirectPage(
  lang: string,
  title: string,
  target: string,
  linkLabel: string,
  meta: readonly string[],
): string {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="dark">
<style>html,body{background:#050507;color:#ffffff}body{margin:0;padding:16px;font:600 13px/1.6 ui-monospace,'SF Mono',Menlo,monospace}a{color:#4a6aff}</style>
<script>location.replace(${JSON.stringify(target).replace(/</g, '\\u003c')})</script>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${meta.join('\n')}
</head>
<body><a href="${escapeAttr(target)}">${linkLabel}</a></body>
</html>`;
}
