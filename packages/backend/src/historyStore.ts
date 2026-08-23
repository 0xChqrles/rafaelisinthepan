// The private player-history row (#211): one item per (player, language) holding that
// language's SOLVED-DAY COLLECTION — the raw fact the streak counters are derived from.
//
// It lives in the PRIVATE player partition (`player#<publicId>`, the #188 profile row's
// own), under its own `history#<lang>` sort key, so it is reachable only through the
// authenticated history read and never through the public `GET /profile?id=`. A counter
// would not do: `StreakDialog` renders the week row, and a raw number cannot say whether
// the streak has since broken.
//
// It is a REBUILDABLE CACHE of the authoritative solved round rows, not a second authority.
// That is what makes the write cheap and idempotent — a solve simply ADDs its day to a set —
// and what makes bounding it (`MAX_SOLVED_DAYS`) harmless.

import { profileKey } from './profileStore';

export interface PlayerHistoryStore {
  // The language's solved game days, ascending and bounded. Empty when the player has
  // solved none — that is an ANSWER, not a missing row.
  solvedDays(publicId: string, lang: string): Promise<number[]>;
  // Credit one solved day. IDEMPOTENT by construction (a set insert), because the same
  // solve can be confirmed more than once — a re-published daily is solved again, and a
  // corrective write can re-record a round the store already holds.
  recordSolvedDay(input: { publicId: string; lang: string; day: number }): Promise<void>;
}

// The same PRIVATE player partition the #188 profile row sits in — imported rather than
// respelled, so the two rows can never end up in two partitions.
export const historyPartition = profileKey;

// Per LANGUAGE, because the streak is: a solved day belongs to the language it was solved
// in, and Word mode's runs never touch it (#156), so there is no mode in this key.
export function historySortKey(lang: string): string {
  return `history#${lang}`;
}
