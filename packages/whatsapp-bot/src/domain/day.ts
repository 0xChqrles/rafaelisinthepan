// The bot's one reading of a "YYYY-MM-DD" that a HUMAN or a MODEL supplied — a manual
// podium replay's `date`, a tool call's `date`.
//
// The shared `dayNumber` is `Date.parse`, which ROLLS OVER rather than refusing:
// "2026-02-30" is quietly March 2nd and "2026-13-01" is January 2027, so a typo produces a
// confident answer about a day nobody asked about. Round-tripping through the shared pair
// is the whole check — a date that comes back as itself is real — which keeps those two
// functions the only definition of what a day is, rather than adding a calendar here.

import { dateForDayNumber, dayNumber } from '@whippin/shared';

export function parseDay(date: unknown): number | null {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const day = dayNumber(date);
  return Number.isFinite(day) && dateForDayNumber(day) === date ? day : null;
}
