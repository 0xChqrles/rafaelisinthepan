// THE CORS ANSWER the API gives the web origin, spelled ONCE for its two speakers: the
// handler (backend `handler.ts`), and the CloudFront Function that answers a live route's
// PREFLIGHT at the edge (infra `backend-stack.ts`). A drift between them is a POST the browser
// refuses on one path and not the other.

// How long a browser may reuse one preflight result. /round POSTs continuously while a
// player types (~one write a second), and the default preflight cache is a handful of
// seconds — without this every few writes pay an extra OPTIONS round trip before the write
// it gates. Two hours is Chrome's own ceiling; browsers clamp anything larger to their own
// (WebKit keeps one for ten minutes, which is why the edge answers it).
export const PREFLIGHT_MAX_AGE_SECONDS = '7200';

// CORS headers so the web origin can read responses. `origin` is configured (set to the web
// origin in prod; "*" by default). `Vary: Origin` keeps the CDN honest when a specific origin
// is echoed.
export function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Amz-Content-Sha256',
    // CORS hides EVERY response header from script outside its own safelist, and
    // `Retry-After` is not on it — the /round rate refusal's advertised interval is
    // otherwise a value only curl and `backend:dev` can read, silently null in the
    // browser it exists for.
    'Access-Control-Expose-Headers': 'Retry-After',
    Vary: 'Origin',
  };
}

// The PREFLIGHT's answer (a 204 with no body): the CORS headers and how long to keep them. It
// carries no data, so no `no-store` — what governs its reuse is `Access-Control-Max-Age`.
export function preflightHeaders(origin: string): Record<string, string> {
  return { ...corsHeaders(origin), 'Access-Control-Max-Age': PREFLIGHT_MAX_AGE_SECONDS };
}
