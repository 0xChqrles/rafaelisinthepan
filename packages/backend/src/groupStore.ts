// Groups (#271, user-decided 2026-09-07): a NAMED SET OF MEMBERS with an invite link, the
// unit every trusted board is drawn over. It replaced the #189 friends graph outright —
// a pair of friends is a group of two — with no back-compat: the edges, their routes and
// their board are gone.
//
// THREE item shapes, all on the score table beside everything else:
//
//   `group#<id>` / `group`              — the group itself: name, creator, createdAt.
//   `group#<id>` / `member#<publicId>`  — one MEMBERSHIP, seen from the group: the
//                                          board's member list is one Query.
//   `player#<publicId>` / `group#<id>`  — the same membership seen from the player: the
//                                          caller's own groups are one Query over the
//                                          partition their profile and account already
//                                          share. It DENORMALIZES the group's name and
//                                          creator, which never change (there is no
//                                          rename), so the list needs no second read.
//
// A membership is BOTH rows or NEITHER — written and deleted in one transaction, so no
// reader can ever see a member the group does not list, or a group the member does not.
// A group is created WITH its creator's membership in the same transaction: a group with
// nobody in it is unreachable by construction, though one can be LEFT empty (the row then
// lingers, joinable through its link — accepted).
//
// The caps are COUNTED off the rows themselves rather than kept in a counter item, for
// the reason the histogram is derived from the score rows: a second store answering the
// same question drifts. Two concurrent joins can therefore both pass a check at 49 and
// land a 51st member — a cap is a BOUND on griefing and on a board read's size, not an
// invariant, and overshooting it by the number of simultaneous taps costs nothing.

import { GROUP_MEMBERS_MAX, GROUPS_MAX } from '@whippin/shared';

export { GROUP_MEMBERS_MAX, GROUPS_MAX };

export interface GroupRecord {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
}

export interface GroupMember {
  publicId: string;
  joinedAt: string;
}

// One of a player's memberships, read off their own partition: the group's immutable
// facts (denormalized onto the row) and when this player joined. The route adds who else
// is in it before answering.
export interface GroupMembership {
  id: string;
  name: string;
  createdBy: string;
  joinedAt: string;
}

export interface GroupCreateInput {
  id: string;
  name: string;
  createdBy: string;
  now: string;
}

// What one CREATE did:
//   created     — the group and its creator's membership exist;
//   group_limit — the creator is already in GROUPS_MAX groups; nothing changed;
//   gone        — the creator's account row disappeared before the write (#204); nothing
//                 changed, so no group exists that nobody is in.
export type GroupCreateOutcome = 'created' | 'group_limit' | 'gone';

export interface GroupJoinInput {
  id: string;
  publicId: string;
  now: string;
}

// What one JOIN did:
//   joined        — the membership exists now;
//   already       — it existed before; nothing changed (a re-tap on a link is ordinary);
//   unknown_group — no group has this id (a mistyped link, or one whose group never
//                   existed); nothing changed;
//   group_full    — the group holds GROUP_MEMBERS_MAX members; nothing changed;
//   group_limit   — the caller is in GROUPS_MAX groups already; nothing changed;
//   gone          — the caller's account row disappeared before the write; nothing changed.
export type GroupJoinOutcome =
  | 'joined'
  | 'already'
  | 'unknown_group'
  | 'group_full'
  | 'group_limit'
  | 'gone';

export interface GroupStore {
  get(id: string): Promise<GroupRecord | null>;
  // The group's members, oldest membership first (ties by id) — the order every surface
  // lists them in, so two reads never shuffle a board's tabs or a card's marks.
  members(id: string): Promise<GroupMember[]>;
  // The caller's own groups, oldest membership first, off their own partition alone.
  listMine(publicId: string): Promise<GroupMembership[]>;
  // The group row AND the creator's membership pair, ONE create-only transaction that
  // also asserts the creator's account still exists.
  create(input: GroupCreateInput): Promise<GroupCreateOutcome>;
  // Both membership rows, ONE transaction asserting the group row and the caller's
  // account both still exist. Refuses at either cap for a membership the caller does not
  // already hold.
  join(input: GroupJoinInput): Promise<GroupJoinOutcome>;
  // Both rows or neither, idempotent: leaving a group one is not in is a no-op, so a
  // stray half-membership can always be cleared from either side too. The creator's
  // REMOVE of a member is this same write, authorized by the route.
  leave(id: string, publicId: string): Promise<void>;
  // Every membership of one player, for the #204 departure a deleted account owes:
  // re-read until the partition is empty, so a membership landing between two passes
  // goes with the rest. IDEMPOTENT (deletes are no-ops), because the job that drives it
  // is resumed after partial batches.
  leaveAll(publicId: string): Promise<void>;
}

// The group's own partition; the sort key is `group` for the record and `member#<id>`
// for each membership.
export function groupKey(id: string): string {
  return `group#${id}`;
}
export const GROUP_SORT_KEY = 'group';
export const MEMBER_SORT_PREFIX = 'member#';
export function memberSortKey(publicId: string): string {
  return `${MEMBER_SORT_PREFIX}${publicId}`;
}

// The player-side row shares the player's `player#<id>` partition (`profileKey`'s and
// `accountKey`'s spelling) under a `group#<id>` sort key, so one Query on the partition
// still shows everything an account is.
export function playerGroupsKey(publicId: string): string {
  return `player#${publicId}`;
}
export const PLAYER_GROUP_SORT_PREFIX = 'group#';
export function playerGroupSortKey(id: string): string {
  return `${PLAYER_GROUP_SORT_PREFIX}${id}`;
}

// The order every member list and every group list is answered in: oldest first, ties by
// id — deterministic between reads and between the two store implementations.
export function byJoinedAt<T extends { joinedAt: string }>(
  rows: readonly T[],
  id: (row: T) => string,
): T[] {
  return [...rows].sort((a, b) =>
    a.joinedAt === b.joinedAt
      ? id(a) < id(b)
        ? -1
        : id(a) > id(b)
          ? 1
          : 0
      : a.joinedAt < b.joinedAt
        ? -1
        : 1,
  );
}
