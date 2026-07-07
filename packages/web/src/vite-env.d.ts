/// <reference types="vite/client" />
// Types the `?react` SVG import (vite-plugin-svgr): `import Icon from './x.svg?react'`.
/// <reference types="vite-plugin-svgr/client" />

// Augment Vite's env typing with our build-time config.
interface ImportMetaEnv {
  // Base URL of the daily-puzzle backend (Lambda Function URL behind CloudFront).
  // Unset in local dev with no backend; required for normal play in production.
  readonly VITE_API_BASE_URL?: string;
  // Plausible site domain (analytics, #60). Committed in .env.production so production
  // builds report; unset in dev (dev never loads .env.production) -> analytics inert.
  // When set, analytics.ts loads the Plausible script. Optional.
  readonly VITE_PLAUSIBLE_DOMAIN?: string;
}
