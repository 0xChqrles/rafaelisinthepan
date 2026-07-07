// The ONE module that knows Plausible exists (issue #60). Privacy-first, cookieless
// analytics: no cookies, no consent banner needed (the developer is in France, so this
// is GDPR-relevant), ~1 KB script. This is an explicit, user-approved EXCEPTION to the
// repo's no-third-party-origin stance (the same rationale that self-hosts the pixel
// font) — decided 2026-07-07. Proxying the script through our own domain is a possible
// later step.
//
// Env-gated by `VITE_PLAUSIBLE_DOMAIN` = the site's domain as registered in Plausible
// (e.g. whippin.ai). It is set ONLY on the CI production deploy (a GitHub repo variable,
// see deploy.yml) and deliberately NOT in `.env.production`, so dev / preview / local
// `pnpm build` all leave it unset and analytics stays fully inert: no script is loaded
// and every `track()` is a no-op.

const PLAUSIBLE_DOMAIN = import.meta.env.VITE_PLAUSIBLE_DOMAIN;

// Low-cardinality event props ONLY. NEVER a typed word or guess (privacy).
type Props = Record<string, string | number>;

// Plausible's tracking function (and, before the script loads, the queue stub below).
type Plausible = {
  (event: string, options?: { props?: Props }): void;
  q?: unknown[];
};

declare global {
  interface Window {
    plausible?: Plausible;
  }
}

// Called ONCE from main.tsx. When configured, drops in Plausible's documented custom-
// events snippet: the tracking script (`defer`, `data-domain`) plus a queue stub so a
// `track()` fired before the async script finishes loading is buffered and flushed on
// load (our three events are user-triggered, so post-load, but the stub keeps `track`
// reliable regardless). Unconfigured -> does nothing, leaving `window.plausible` unset.
export function initAnalytics(): void {
  if (!PLAUSIBLE_DOMAIN) return;

  const stub: Plausible = (...args: unknown[]) => {
    (stub.q = stub.q || []).push(args);
  };
  window.plausible = window.plausible || stub;

  const script = document.createElement('script');
  script.defer = true;
  script.dataset.domain = PLAUSIBLE_DOMAIN;
  script.src = 'https://plausible.io/js/script.js';
  document.head.appendChild(script);
}

// Fire a custom event. Silent no-op when analytics is unconfigured/absent, and it NEVER
// throws — analytics must never break the game.
export function track(event: string, props?: Props): void {
  try {
    window.plausible?.(event, props ? { props } : undefined);
  } catch {
    // Swallow: a broken/blocked analytics call must never surface to the player.
  }
}
