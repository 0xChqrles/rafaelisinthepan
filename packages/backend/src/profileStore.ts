// The #188 player profile row: ONE item per publicId — name + encoded avatar — upserted
// by the authenticated profile write and read when a board resolves rows to display
// (#190). A separate write path from scores: customizing a profile never touches a
// score row.

export interface ProfileRecord {
  publicId: string;
  name: string;
  avatar: string;
}

export interface ProfileUpsert extends ProfileRecord {
  // ISO instant of this write; the store keeps createdAt from the first write only.
  now: string;
}

export interface ProfileStore {
  get(publicId: string): Promise<ProfileRecord | null>;
  upsert(input: ProfileUpsert): Promise<void>;
}

// The player item shares the score table: its own partition per player, constant sort
// key (the same single-item shape as the dedup items).
export function profileKey(publicId: string): string {
  return `player#${publicId}`;
}

export const PROFILE_SORT_KEY = 'profile';
