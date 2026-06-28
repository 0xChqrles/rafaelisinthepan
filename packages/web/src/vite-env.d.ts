/// <reference types="vite/client" />

// Augment Vite's env typing with our build-time config.
interface ImportMetaEnv {
  // Base URL of the daily-puzzle backend (Lambda Function URL behind CloudFront).
  // Unset in local dev with no backend; required for normal play in production.
  readonly VITE_API_BASE_URL?: string;
}
