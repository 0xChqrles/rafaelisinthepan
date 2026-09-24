import { dateForDayNumber } from './day';

// BONUS puzzles (2026-09-24): a test puzzle published OUTSIDE the daily calendar and played
// by link only — like an archive day, but it is no day: it earns no score row, no streak
// credit and no podium, and its result card is its own (share token v7, `shareCard.ts`).
//
// Its ID is SEVEN digits, never a leading zero (1000000..9999999): short enough to read
// out, random enough that a link is the only way in. The one spelling of it for every
// package: the web routes on it, the backend serves and stores by it, the publish script
// mints it, the share codec packs it.
export const BONUS_ID_SOURCE = '[1-9][0-9]{6}';
export const BONUS_ID_PATTERN = new RegExp(`^${BONUS_ID_SOURCE}$`);
export const BONUS_ID_MIN = 1_000_000;
export const BONUS_ID_MAX = 9_999_999;

export function isBonusId(id: string): boolean {
  return BONUS_ID_PATTERN.test(id);
}

// A puzzle's ADDRESS in the store and on its round row: the game day ("YYYY-MM-DD") for a
// daily, `bonus/<id>` for a bonus. Whatever reads an address AS A DATE (early play, the
// on-time credit, the future-day guard) asks `isBonusAddress` first.
export const BONUS_ADDRESS_PREFIX = 'bonus/';

export function bonusAddress(id: string): string {
  return `${BONUS_ADDRESS_PREFIX}${id}`;
}

export function isBonusAddress(address: string): boolean {
  return address.startsWith(BONUS_ADDRESS_PREFIX);
}

// The bonus's page: `/<lang>/bonus/<id>`, under the language like a dated day.
export const BONUS_SEGMENT = 'bonus';

export function bonusPath(lang: string, id: string | number): string {
  return `/${lang}/${BONUS_SEGMENT}/${id}`;
}

// WHICH PUZZLE a round or a result is: a game day, or a bonus — never both. The share
// token's `dayNumber` / `bonusId` pair (`shareCard.ts`), as one value.
export type PuzzleRef = { dayNumber: number } | { bonusId: number };

export function isBonusRef(ref: PuzzleRef): ref is { bonusId: number } {
  return 'bonusId' in ref;
}

// The puzzle's ADDRESS (above): the day's date, or the bonus's `bonus/<id>`.
export function puzzleAddress(ref: PuzzleRef): string {
  return isBonusRef(ref) ? bonusAddress(String(ref.bonusId)) : dateForDayNumber(ref.dayNumber);
}
