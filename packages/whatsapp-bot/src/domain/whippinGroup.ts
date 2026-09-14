// THE WHIPPIN GROUP a WhatsApp group plays as (`GroupConfig.whippinGroup`, user-decided
// 2026-09-14): its invite link, and the one read that says whether the link still leads
// anywhere. The morning reminder is the only reader.
//
// THE LINK IS THE SHARED CONTRACT'S (`groupInvitePath`, `shared/src/invite.ts`) — the path
// the backend renders the preview card at and the web lands on — plus a `v` the path does
// not know: the reminder's day number, a new one every morning. The CDN neither keys on nor
// forwards it (`CACHING_OPTIMIZED` on `/g/*`), so it changes nothing about what is served;
// what it changes is the URL, and a client that remembers a link's preview by its URL is
// handed a new one every day, so the card it shows counts today's members.
//
// AND IT IS READ BEFORE IT IS PRINTED. A deleted group's link does not fail: the web CDN
// answers every miss with the app's index.html and a 200, so the page unfurls as the generic
// Whippin card and the landing finds nothing — the 404 the reminder must never invite a group
// to, wearing a 200. The API's public face (`GET /groups?id=`) is the one place that says
// so, with a 404 `unknown_group`.

import { groupInvitePath } from '@whippin/shared';
import type { Log } from '../log';

const FETCH_TIMEOUT_MS = 10_000;

export function groupInviteUrl(siteOrigin: string, groupId: string, dayNumber: number): string {
  return `${siteOrigin}${groupInvitePath(groupId)}?v=${dayNumber}`;
}

export interface WhippinGroupReader {
  // true: the group stands. false: it is gone, and its link would land nowhere. null: the
  // read failed, which is not an answer.
  stands(groupId: string): Promise<boolean | null>;
}

// No group id in any log line: an invite link is a way in, not an identifier.
export function createWhippinGroupReader(deps: { apiBaseUrl: string; log: Log; fetchImpl?: typeof fetch }): WhippinGroupReader {
  const doFetch = deps.fetchImpl ?? fetch;
  return {
    async stands(groupId) {
      let response: Response;
      try {
        response = await doFetch(`${deps.apiBaseUrl}/groups?id=${encodeURIComponent(groupId)}`, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (error) {
        deps.log.warn({ event: 'whippin_group.unreachable', error: (error as Error).message }, 'could not read the Whippin group');
        return null;
      }
      if (response.status === 404) return false;
      if (!response.ok) {
        deps.log.warn({ event: 'whippin_group.failed', status: response.status }, 'the Whippin group did not load');
        return null;
      }
      // A 200 is an answer only when it is THE GROUP's face: anything else there is a read
      // that went wrong somewhere between here and the backend.
      const face = (await response.json().catch(() => null)) as { id?: unknown } | null;
      if (face?.id === groupId) return true;
      deps.log.warn({ event: 'whippin_group.unparseable' }, 'the Whippin group did not parse');
      return null;
    },
  };
}
