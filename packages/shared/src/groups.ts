// Groups (#271, user-decided 2026-09-07): what a group IS on the wire, how its id is
// spelled, and which days a WEEK or a MONTH board reads. Cross-package because the
// backend mints and validates the id, the web parses it out of a landing path, and both
// have to agree on what "this week" means before one of them ranks it.

import { dateForDayNumber, dayNumber } from './day';
import { PUBLIC_ID_PATTERN, PUBLIC_ID_SOURCE, generatePublicId } from './identity';
import type { BoardPlayer } from './leaderboard';

// A group id is the same 16-character base32 shape as a player id — an invite link IS
// one (`/g/<groupId>`), so it needs the same URL-safe alphabet — and it is read in the
// same places (a body field, a path segment), so it is the same rule rather than a second.
export const GROUP_ID_SOURCE = PUBLIC_ID_SOURCE;
export const GROUP_ID_PATTERN = PUBLIC_ID_PATTERN;

export function generateGroupId(): string {
  return generatePublicId();
}

// What `POST /groups` answers, one entry per group the caller is in: the group's own
// facts, when THIS player joined it (the list is ordered by it, oldest first, so the board
// tabs never shuffle between reads), and who is in it — public ids, oldest membership
// first — which is what lets the global board mark the reader's own people.
export interface GroupSummary {
  id: string;
  name: string;
  createdBy: string;
  joinedAt: string;
  members: string[];
}

// What `GET /groups?id=` answers: a group's PUBLIC face, the one a person sees before they
// join — its name, its creator, and its members dressed the way a board row is (a member
// who never customized a profile carries '' / null, and every surface draws the assigned
// identity for them). No scores: those are for members only.
export interface PublicGroup {
  id: string;
  name: string;
  createdBy: string;
  members: BoardPlayer[];
}

// The three boards a group has (#271): the DAY board is the live one — finished, playing
// and waiting rows, the friends board's own shape — and WEEK / MONTH are ranked by the
// shared period rule over the recorded scores of every day in the range.
export type BoardPeriod = 'day' | 'week' | 'month';

export const BOARD_PERIODS: readonly BoardPeriod[] = ['day', 'week', 'month'];

export function isBoardPeriod(value: unknown): value is BoardPeriod {
  return typeof value === 'string' && (BOARD_PERIODS as readonly string[]).includes(value);
}

// WHICH DAYS a period board reads, ending on the day the board is addressed by: the
// calendar WEEK (Monday first — the week people say "this week" about) and the calendar
// MONTH, both cut at `date` so no day past the one asked about is read (a future day has
// no recorded score anyway — an early round never solves — but the batch stays small).
// Ascending, inclusive, ISO dates; `day` is the one day itself.
export function periodRange(period: BoardPeriod, date: string): string[] {
  if (period === 'day') return [date];
  const last = dayNumber(date);
  let first: number;
  if (period === 'week') {
    // `getUTCDay` is 0 for Sunday; a Monday-first week puts Sunday six days in.
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    first = last - ((weekday + 6) % 7);
  } else {
    first = dayNumber(`${date.slice(0, 7)}-01`);
  }
  const days: string[] = [];
  for (let day = first; day <= last; day += 1) days.push(dateForDayNumber(day));
  return days;
}
