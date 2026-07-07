// The ONE module that knows Plausible exists (issue #60). Privacy-first, cookieless
// analytics: no cookies, no consent banner needed (the developer is in France, so this
// is GDPR-relevant). This is an explicit, user-approved EXCEPTION to the repo's
// no-third-party-origin stance (the same rationale that self-hosts the pixel font) —
// decided 2026-07-07. Proxying the endpoint through our own domain is a possible later
// step.
//
// Env-gated by `VITE_PLAUSIBLE_DOMAIN` = the site's domain as registered in Plausible
// (e.g. whippin.ai). It is set ONLY on the CI production deploy (a GitHub repo variable,
// see deploy.yml) and deliberately NOT in `.env.production`, so dev / preview / local
// `pnpm build` all leave it unset and analytics stays fully inert: no tracker is loaded
// and every `track()` is a no-op.

import type { CustomProperties } from '@plausible-analytics/tracker';

const PLAUSIBLE_DOMAIN = import.meta.env.VITE_PLAUSIBLE_DOMAIN;

// Low-cardinality event props ONLY. NEVER a typed word or guess (privacy).
type Props = Record<string, string | number>;
type Tracker = typeof import('@plausible-analytics/tracker');

let trackerPromise: Promise<Tracker> | null = null;

function toPlausibleProps(props?: Props): CustomProperties | undefined {
  if (!props) return undefined;
  return Object.fromEntries(Object.entries(props).map(([key, value]) => [key, String(value)]));
}

function loadTracker(): Promise<Tracker> | null {
  if (!PLAUSIBLE_DOMAIN) return null;
  if (trackerPromise) return trackerPromise;

  trackerPromise = import('@plausible-analytics/tracker')
    .then((tracker) => {
      tracker.init({
        domain: PLAUSIBLE_DOMAIN,
        // Keep ignored localhost/blocked-event noise out of the console. This is still
        // normally initialized only on the CI-built production site.
        logging: false,
      });
      return tracker;
    })
    .catch((err) => {
      trackerPromise = null;
      throw err;
    });
  return trackerPromise;
}

// Called ONCE from main.tsx. When configured, initializes Plausible's official tracker
// package, including its SPA pageview handling. Unconfigured -> does nothing.
export function initAnalytics(): void {
  loadTracker()?.catch(() => {
    // Swallow: analytics must never break the game.
  });
}

// Fire a custom event. Silent no-op when analytics is unconfigured/absent, and it NEVER
// throws — analytics must never break the game.
export function track(event: string, props?: Props): void {
  loadTracker()
    ?.then((tracker) => {
      const plausibleProps = toPlausibleProps(props);
      tracker.track(event, plausibleProps ? { props: plausibleProps } : {});
    })
    .catch(() => {
      // Swallow: a broken/blocked analytics call must never surface to the player.
    });
}
