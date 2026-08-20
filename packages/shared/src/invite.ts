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
// drift between any two of them is an invite that silently lands nobody on the board —
// and it is invisible in local development, where there is no CDN in front of the SPA
// and `/i/*` never reaches the backend at all. Hence one module, like VIEWER_IP_HEADER.
//
// The link stayed `/i/<publicId>` through the change so every link already in the wild
// keeps working and simply gains a preview; what moved is the SPA landing underneath it.

export const INVITE_SEGMENT = 'i';
export const INVITE_LANDING_SEGMENT = 'join';

// The shared link. The id is validated where it is READ (the backend route, the SPA's
// parseRoute), so a mistyped link is an unknown path rather than a lookup.
export function invitePath(publicId: string): string {
  return `/${INVITE_SEGMENT}/${publicId}`;
}

export function inviteLandingPath(publicId: string): string {
  return `/${INVITE_LANDING_SEGMENT}/${publicId}`;
}

// The preview image sits under `/og/` with the share cards, so the CDN behavior that
// already proxies them covers it. The `i/` segment is what keeps it out of the share
// token's namespace: a publicId is 16 base32 characters, which a token regex would
// otherwise be free to read as a (malformed) token.
export function inviteCardPath(publicId: string): string {
  return `/og/${INVITE_SEGMENT}/${publicId}.png`;
}
