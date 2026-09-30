// The #188 player profile row: ONE item per publicId — name + encoded avatar — written
// by the authenticated profile route and read when a board resolves rows to display
// (#190). Ordinary editor writes upsert; the locally-decided background identity uses an
// atomic create. A separate write path from scores: customizing a profile never touches
// a score row.

export interface ProfileRecord {
  publicId: string;
  name: string;
  avatar: string;
}

// How a profile DRESSES the player it belongs to — the name and mark a board row, a group
// face and a signed share draw. A player with no profile is blank (the client derives the
// assigned identity from the publicId), and an EMPTY stored avatar is "no mark": `''` is
// not a decodable avatar, and the client's fallback is keyed on null.
export function faceOf(profile: ProfileRecord | null | undefined): {
  name: string;
  avatar: string | null;
} {
  return { name: profile?.name ?? '', avatar: profile?.avatar || null };
}

export interface ProfileUpsert extends ProfileRecord {
  // ISO instant of this write; the store keeps createdAt from the first write only.
  now: string;
}

// What an identity-bearing read learns about a player: whether the ACCOUNT still exists,
// and the row it customized (null when it never did).
//
// The two are one answer since #204, because an email link can DELETE the account a device
// leaves. A missing profile then means two very different things — "never customized",
// which every board dresses with the ASSIGNED pseudonym and mark, and "this player is
// gone", which must be dressed with nothing at all. Both rows live in the same
// `player#<id>` partition, so asking for both costs one read.
interface ProfileLookup {
  live: boolean;
  profile: ProfileRecord | null;
}

export interface ProfileStore {
  get(publicId: string): Promise<ProfileLookup>;
  // Install the first profile only. False means another writer already created the row;
  // the existing profile is left byte-for-byte untouched. The local-identity deployment
  // uses this rather than a read-then-upsert race with the profile editor or another device.
  create(input: ProfileUpsert): Promise<boolean>;
  upsert(input: ProfileUpsert): Promise<void>;
}

// THE PLAYER PARTITION, `player#<publicId>`: everything an account IS sits in it — this
// profile row, the account row, the solved-day collections, the player side of each group
// membership. Spelled ONCE; the modules owning those rows alias it under their own names
// rather than respelling it, so no two of them can ever end up in two partitions.
export function playerPartition(publicId: string): string {
  return `player#${publicId}`;
}

// The player item shares the score table: its own partition per player, constant sort
// key (the same single-item shape as the dedup items).
export const profileKey = playerPartition;

export const PROFILE_SORT_KEY = 'profile';
