// The #189 invite link's three paths, in ONE place because THREE packages have to agree
// on them (2026-08-20, when the link gained a server-rendered preview):
//
//   /i/<publicId>          the LINK a player shares. Served by the BACKEND, so the
//                          unfurl carries that player's own mark and name instead of
//                          the SPA's generic card. It carries no behavior of its own —
//                          it renders the preview and bounces a human onward.
//   /join/<publicId>       the SPA landing it bounces to: the screen that actually
//                          records the mutual edge with the CLICKER's key.
//   /og/i/<publicId>.png   the preview image the link's OG tags point at.
//
// INFRA routes `/i/*` to the API origin, the BACKEND answers it and writes the landing
// URL into its redirect, and the WEB builds the shared link and parses the landing. A
// drift between any two of them is an invite that silently lands nobody on the board,
// which is why they are one module, like VIEWER_IP_HEADER.
//
// The web's DEV SERVER proxies the same paths to the local backend (vite.config.ts), so
// a pasted link walks the same two steps locally that it does in production. It did not
// at first, and the failure had no symptom: the SPA fallback answered `/i/<id>` with
// index.html, the router saw a path it no longer owned, and the click landed on the game
// with nothing said and no edge written.
//
// The link stayed `/i/<publicId>` through the change so every link already in the wild
// keeps working and simply gains a preview; what moved is the SPA landing underneath it.

export const INVITE_SEGMENT = 'i';
export const INVITE_LANDING_SEGMENT = 'join';
export const SHARE_SEGMENT = 's';

// A share token's alphabet (base64url), the ONE spelling every reader of a share PATH
// uses to pick the token out of it: the backend's route regexes and the bot's message
// scanner embed `SHARE_TOKEN_SOURCE` in their own expressions, the SPA's landing parser
// tests a whole segment with `SHARE_TOKEN_PATTERN`. It stops at `/`, which is what lets a
// SIGNED share carry its second segment (below) without any of them re-reading the link.
export const SHARE_TOKEN_SOURCE = '[A-Za-z0-9_-]+';
export const SHARE_TOKEN_PATTERN = new RegExp(`^${SHARE_TOKEN_SOURCE}$`);

// A RESULT SHARE, and the SIGNED share it can become (user-decided 2026-09-05):
//
//   /s/<token>               the result alone — content-addressed, cached a year.
//   /s/<token>/<publicId>    the result SIGNED by its player: the card carries their mark
//                            and name, and the click lands on the invite landing WITH the
//                            result, where ADD FRIEND records the mutual edge. It is the
//                            solved screen's INVITE toggle (default on, never persisted).
//   /og/<token>.png          the card; `/og/<token>/<publicId>.png` the signed card.
//   /join/<publicId>/<token> the signed share's landing: the plain invite landing, showing
//                            the shared result over the face.
//
// The token is UNTOUCHED by the signature — the codec carries no identity, so every
// existing link keeps working and the bot reads a signed share exactly as it read a plain
// one. The identity rides a second path segment so that turning the toggle OFF yields
// today's link byte for byte. A signed page is NOT content-addressed (the player can rename
// or redraw), so the backend serves it with the invite preview's short TTL.
export function sharePath(token: string, by?: string | null): string {
  return by ? `/${SHARE_SEGMENT}/${token}/${by}` : `/${SHARE_SEGMENT}/${token}`;
}

export function shareCardPath(token: string, by?: string | null): string {
  return by ? `/og/${token}/${by}.png` : `/og/${token}.png`;
}

// The shared link. The id is validated where it is READ (the backend route, the SPA's
// parseRoute), so a mistyped link is an unknown path rather than a lookup.
export function invitePath(publicId: string): string {
  return `/${INVITE_SEGMENT}/${publicId}`;
}

export function inviteLandingPath(publicId: string, token?: string | null): string {
  return token
    ? `/${INVITE_LANDING_SEGMENT}/${publicId}/${token}`
    : `/${INVITE_LANDING_SEGMENT}/${publicId}`;
}

// The preview image sits under `/og/` with the share cards, so the CDN behavior that
// already proxies them covers it. The `i/` segment is what keeps it out of the share
// token's namespace: a publicId is 16 base32 characters, which a token regex would
// otherwise be free to read as a (malformed) token.
export function inviteCardPath(publicId: string): string {
  return `/og/${INVITE_SEGMENT}/${publicId}.png`;
}
