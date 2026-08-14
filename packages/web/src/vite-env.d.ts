/// <reference types="vite/client" />
// Types the `?react` SVG import (vite-plugin-svgr): `import Icon from './x.svg?react'`.
/// <reference types="vite-plugin-svgr/client" />

// Augment Vite's env typing with our build-time config.
interface ImportMetaEnv {
  // Base URL of the daily-puzzle backend (Lambda Function URL behind CloudFront).
  // Unset in local dev with no backend; required for normal play in production.
  readonly VITE_API_BASE_URL?: string;
  // Plausible site domain (analytics, #60). Set ONLY on the CI production deploy so
  // dev/preview/local builds stay inert; when set, analytics.ts loads Plausible's
  // official tracker package. Optional.
  readonly VITE_PLAUSIBLE_DOMAIN?: string;
  // Cloudflare Turnstile SITE key (#170) — the public half of the pair whose secret the
  // backend verifies (#169). Unset → score submission is skipped silently (the solved
  // screen just shows no histogram); .env.example carries Cloudflare's always-passing
  // invisible TEST key for local play against `pnpm backend:dev`.
  readonly VITE_TURNSTILE_SITE_KEY?: string;
}
