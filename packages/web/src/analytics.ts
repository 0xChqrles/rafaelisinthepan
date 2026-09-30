// The ONE module that knows Umami exists (issue #60; Plausible until 2026-09-28, when
// the user moved to Umami Cloud for the read API and the event properties at the same
// price). Privacy-first, cookieless analytics: no cookies, no consent banner needed (the
// developer is in France, so this is GDPR-relevant). This is an explicit, user-approved
// EXCEPTION to the repo's no-third-party-origin stance (the same rationale that
// self-hosts the pixel font) — decided 2026-07-07.
//
// Env-gated by `VITE_UMAMI_WEBSITE_ID` = the website's id in Umami Cloud. It is set ONLY
// on the CI production deploy (a GitHub repo variable, see deploy.yml) and deliberately
// NOT in `.env.production`, so dev / preview / local `pnpm build` all leave it unset and
// analytics stays fully inert: no script is loaded and every `track()` is a no-op.
//
// Umami ships no npm tracker, so its official script is injected here. It must be a real
// <script> element (it reads `document.currentScript` for its attributes), it records the
// page it loads on and every URL change the app makes through pushState/replaceState,
// and it sends to `https://gateway.umami.is` — both hosts are in the CSP
// (`infra/lib/web-stack.ts`). Where it differs from Plausible, this module restates
// Plausible's behaviour: Back/Forward count, a same-site referrer is dropped, and a page
// counts once per path.

import { GROUP_LANDING_SEGMENT, GROUP_SEGMENT } from '@whippin/shared';

const WEBSITE_ID = import.meta.env.VITE_UMAMI_WEBSITE_ID;
const SCRIPT_SRC = 'https://cloud.umami.is/script.js';
// The global Umami calls before every send (`window.whippinUmamiBeforeSend`), named to it
// by `data-before-send`.
const BEFORE_SEND = 'whippinUmamiBeforeSend';
// The group invite landing, `/join/g/<groupId>`, as the one page Umami is told about.
const INVITE_LANDING = `/${GROUP_LANDING_SEGMENT}/${GROUP_SEGMENT}`;

// Low-cardinality event props ONLY. NEVER a typed word or guess (privacy). Umami bills
// every stored property as one event, so a prop that says nothing is not free either.
type Props = Record<string, string | number>;

interface Umami {
  track(event: string, data?: Props): unknown;
}

// What the script is about to send: `name` is set on a custom event, absent on a pageview.
interface UmamiPayload {
  url?: string;
  referrer?: string;
  name?: string;
  [key: string]: unknown;
}

declare global {
  interface Window {
    umami?: Umami;
    whippinUmamiBeforeSend?: (type: string, payload: UmamiPayload) => UmamiPayload | null;
  }
}

let trackerPromise: Promise<Umami> | null = null;
let lastPageviewPath: string | null = null;

// What the hook does with one payload, pure (tested): the payload to send — null drops
// it — and the path the next pageview is compared against.
// - A referrer from this site is dropped. The script sends one as a bare path, and the
//   one such path that is not also a page of the app is a signed share's
//   `/s/<token>/<publicId>`, which would hand Umami the sharer's player id on every
//   click-through.
// - A pageview counts once per PATH. Umami counts every URL change, a replace or a
//   query-only one included, so `dropLangParam` would count a page nobody moved to.
// - The group invite landing is sent as `/join/g`, on a pageview and an event alike: its
//   path carries the group's id, and knowing the id is enough to JOIN the group. The
//   once-per-path count still reads the real path.
export function screenPayload(
  payload: UmamiPayload,
  lastPath: string | null,
  href: string,
): { payload: UmamiPayload | null; lastPath: string | null } {
  const sent = payload.referrer?.startsWith('/') ? { ...payload, referrer: undefined } : payload;
  if (sent.url === undefined) return { payload: sent, lastPath };
  const path = new URL(sent.url, href).pathname;
  const scrubbed = path.startsWith(`${INVITE_LANDING}/`) ? { ...sent, url: INVITE_LANDING } : sent;
  if (sent.name !== undefined) return { payload: scrubbed, lastPath };
  if (path === lastPath) return { payload: null, lastPath };
  return { payload: scrubbed, lastPath: path };
}

// A falsy answer drops the payload. The two rules Plausible applied on its own are
// `screenPayload`'s.
function beforeSend(_type: string, payload: UmamiPayload): UmamiPayload | null {
  const screened = screenPayload(payload, lastPageviewPath, window.location.href);
  lastPageviewPath = screened.lastPath;
  return screened.payload;
}

// Loaded ONCE per page. A blocked or failed script stays failed for the page's life: an
// ad blocker answers every retry the same way, and each retry would add a script tag.
function loadTracker(): Promise<Umami> | null {
  if (!WEBSITE_ID) return null;
  if (trackerPromise) return trackerPromise;

  trackerPromise = new Promise<Umami>((resolve, reject) => {
    window.whippinUmamiBeforeSend = beforeSend;
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.dataset.websiteId = WEBSITE_ID;
    script.dataset.beforeSend = BEFORE_SEND;
    script.onload = () => {
      const umami = window.umami;
      if (!umami) {
        reject(new Error('umami: script loaded without its global'));
        return;
      }
      // Umami follows pushState/replaceState but never popstate: without this, Back and
      // Forward send no pageview and leave its idea of the current page stale, so the
      // next push to that page is dropped as a repeat and events carry the wrong page.
      // Replacing the entry with itself runs Umami's own replace hook; the entry, its
      // state and the app's listeners are untouched.
      window.addEventListener('popstate', () => {
        window.history.replaceState(window.history.state, '', window.location.href);
      });
      resolve(umami);
    };
    script.onerror = () => reject(new Error('umami: script failed to load'));
    document.head.appendChild(script);
  });
  return trackerPromise;
}

// Called ONCE from main.tsx. When configured, loads Umami's script, which records the
// pageviews on its own. Unconfigured -> does nothing.
export function initAnalytics(): void {
  loadTracker()?.catch(() => {
    // Swallow: analytics must never break the game.
  });
}

// Fire a custom event. Silent no-op when analytics is unconfigured/absent, and it NEVER
// throws — analytics must never break the game.
export function track(event: string, props?: Props): void {
  loadTracker()
    ?.then((umami) => {
      umami.track(event, props);
    })
    .catch(() => {
      // Swallow: a broken/blocked analytics call must never surface to the player.
    });
}
