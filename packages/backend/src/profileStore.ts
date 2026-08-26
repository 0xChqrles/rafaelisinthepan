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
export interface ProfileLookup {
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

// The player item shares the score table: its own partition per player, constant sort
// key (the same single-item shape as the dedup items).
export function profileKey(publicId: string): string {
  return `player#${publicId}`;
}

export const PROFILE_SORT_KEY = 'profile';
