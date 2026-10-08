// A PREVIEW CODE (user-decided 2026-10-08) lets the operator play a FUTURE day early, on its
// real round: the puzzle route and `/round` lift the future-day guard for a request carrying
// that (lang, date)'s code, and a solve made through it is on time. The BACKEND signs and
// verifies it (an HMAC of `preview:<lang>:<date>`, `backend/src/previewCode.ts`); shared holds
// only its name on the wire, its shape, and the page a link opens. Three packages read the
// name — the web forwards it, the backend reads it, infra names it in both CloudFront lists —
// so a drift is a code that never reaches the Lambda.
export const PREVIEW_QUERY = 'preview';

// Sixteen lowercase hex characters: the first 64 bits of the HMAC, never normalized.
export const PREVIEW_CODE_PATTERN = /^[0-9a-f]{16}$/;

export function isPreviewCode(code: string): boolean {
  return PREVIEW_CODE_PATTERN.test(code);
}

// The error CODE of a refused preview code (a 404 on the puzzle route and on `/round`): the
// backend answers it, the web reads it. On `/round` a bare 404 means "no round recorded yet",
// so a refused code must be told apart from it — or a load the server refused would read as
// an empty round the player can type into, whose guesses are never stored.
export const PREVIEW_REFUSED = 'preview_refused';

// The day's page carrying its code — what `pnpm puzzle:preview` prints, one per language.
export function previewPath(lang: string, date: string, code: string): string {
  return `/${lang}/${date}?${PREVIEW_QUERY}=${code}`;
}
