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

// What one add did, told from the CALLER's side:
//   linked — they did not hold this edge and now do;
//   already_linked — they already held it, so their list is unchanged (a re-click of a
//     shared link is an ordinary event, not an error). The write still runs — see below;
//   capped — the pair is new and one of the two is at FRIENDS_MAX; nothing changed.
export type FriendLinkOutcome = 'linked' | 'already_linked' | 'capped';

export interface FriendLinkResult {
  outcome: FriendLinkOutcome;
  // The caller's list as it stands AFTER the call — every /friends response carries it, and
  // deciding the cap already read the whole partition, so asking for it again would be a
  // second Query for an answer this call is holding. The transaction it follows either
  // landed the one edge or changed nothing, so the list is KNOWN rather than guessed.
  friends: string[];
}

export interface FriendStore {
  // The caller's own partition — bounded by FRIENDS_MAX, so it is read whole.
  list(publicId: string): Promise<string[]>;
  // Both directions or neither, and both are written on EVERY accepted call, re-links
  // included: a store can see the caller's own edge but not the friend's, so skipping the
  // write when the caller already holds theirs would leave a missing other half missing for
  // good. Writing both is what makes the pair repair itself from either side. Refuses at the
  // cap on EITHER side of a pair the caller does not already hold: the link is a bearer "add
  // me" token, so a publicly posted one is exactly how a sender's own list would run away
  // from them. Answers with the caller's resulting list as well as the outcome — see
  // FriendLinkResult.
  link(input: FriendLink): Promise<FriendLinkResult>;
  // Symmetric and idempotent for the same reason: deleting an edge that is not there is a
  // no-op, so a stray half-edge can always be cleared from either side too.
  unlink(publicId: string, friendId: string): Promise<void>;
  // The caller's partition WITH the instants each edge was made at — what #204's merge
  // orders by ("fill the remaining capacity oldest-createdAt first, ties by friend id").
  // `list` stays the id-only read every other caller wants.
  entries(publicId: string): Promise<FriendLink[]>;
  // MOVE or DROP a batch of one account's edges as part of a link (#204). Each move rewrites
  // BOTH directions: a KEPT friend F loses `from`↔F and gains `to`↔F, a dropped one just
  // loses `from`↔F — so no edge is ever left pointing at a deleted account. It is IDEMPOTENT
  // (deletes are no-ops, `createdAt` is kept from whichever link is older) because the job
  // that drives it is resumed after partial batches.
  transfer(from: string, to: string, moves: readonly FriendTransfer[]): Promise<void>;
}

// One friendship's fate in a merge. `keep` false is a DROP: `from` had this friend, `to`
// has no capacity left for them, and both `from`-facing rows go.
export interface FriendTransfer {
  friendId: string;
  keep: boolean;
  // The instant the surviving edge should carry — the OLDER of the two, so a merged
  // friendship does not claim to be younger than it is.
  createdAt: string;
}

// Partition of one player's edges; the sort key is the friend's publicId.
export function friendsKey(publicId: string): string {
  return `friends#${publicId}`;
}
