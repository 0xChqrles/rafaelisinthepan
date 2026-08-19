// The #189 friends graph: MUTUAL edges, never follows. A link is written in BOTH
// directions as ONE transaction, so a half-edge can never exist, and removal deletes both
// rows the same way — there is no one-sided hide.
//
// A player's own partition IS their list: `friends#<publicId>`, sort key = the friend's
// publicId, one `createdAt` attribute. That is also why the graph lives here rather than in
// the client's localStorage: an invite link is clicked on the RECEIVER's device, with the
// sender nowhere near it, so only a server-side edge can benefit both sides from one click
// (and, following the derived identity of #187 rather than a device, it travels with a
// restored key for free).

export const FRIENDS_MAX = 200;

export interface FriendLink {
  publicId: string;
  friendId: string;
  // ISO instant of the link, kept from the FIRST one (if_not_exists): re-clicking an invite
  // already accepted must not restate when the two became friends.
  createdAt: string;
}

// What one add did:
//   linked — the pair now holds both edges;
//   already_linked — they were already connected, so nothing changed (a re-click of a
//     shared link is an ordinary event, not an error);
//   capped — one of the two is at FRIENDS_MAX; nothing changed.
export type FriendLinkOutcome = 'linked' | 'already_linked' | 'capped';

export interface FriendStore {
  // The caller's own partition — bounded by FRIENDS_MAX, so it is read whole.
  list(publicId: string): Promise<string[]>;
  // Both directions or neither. Refuses at the cap on EITHER side: the link is a bearer
  // "add me" token, so a publicly posted one is exactly how a sender's own list would run
  // away from them.
  link(input: FriendLink): Promise<FriendLinkOutcome>;
  // Symmetric and idempotent: deleting an edge that is not there is a no-op, which also
  // means a stray half-edge can always be cleared from either side.
  unlink(publicId: string, friendId: string): Promise<void>;
}

// Partition of one player's edges; the sort key is the friend's publicId.
export function friendsKey(publicId: string): string {
  return `friends#${publicId}`;
}
