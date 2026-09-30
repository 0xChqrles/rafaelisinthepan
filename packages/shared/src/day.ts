// The ONE definition of the game day, shared by the backend AND the web client. The
// "active day" — which puzzle is live — flips at 22:00 America/New_York (NYT-style: a
// date's puzzle is released the evening BEFORE that date). The client computes it to
// request the date-addressed puzzle URL; the server computes it to validate that the
// requested date is (within clock skew of) the live one. All conversions are
// DST-correct: the New-York wall clock is read via Intl with `timeZone`, never with a
// fixed UTC offset.

export const TIME_ZONE = 'America/New_York';
// Hour (local, 0-23) at which the active day rolls over to the NEXT calendar date.
export const RESET_HOUR = 22;

interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
}

// Wall-clock components of `instant` in `timeZone`, DST-correct.
export function zonedParts(instant: Date, timeZone = TIME_ZONE): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map: Record<string, number> = {};
  for (const p of fmt.formatToParts(instant)) {
    if (p.type !== 'literal') map[p.type] = Number(p.value);
  }
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    // h23 renders midnight as 24 in some engines; normalise to 0.
    hour: map.hour % 24,
    minute: map.minute,
    second: map.second,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

// "YYYY-MM-DD" of (year, month, day) advanced by `addDays`, using pure calendar
// arithmetic on the date label (no timezone math — the label rollover is offset-free).
function dateLabel(year: number, month: number, day: number, addDays = 0): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + addDays);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// The active puzzle date ("YYYY-MM-DD") for `instant`. Before RESET_HOUR local it is
// today's NY date; at/after it, tomorrow's (the next date's puzzle is live).
export function activeDate(instant: Date): string {
  const p = zonedParts(instant);
  return dateLabel(p.year, p.month, p.day, p.hour >= RESET_HOUR ? 1 : 0);
}

// A strict "YYYY-MM-DD" that is also a real calendar date (rejects 2026-13-40 etc): the
// shape guards the format, and the round trip through a UTC date weeds out impossible days
// (Feb 30) and normalized overflow. The ONE check of the `date` a puzzle is addressed by —
// the web before it routes to a day, the backend before it serves or publishes one.
export function isCalendarDate(date: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return false;
  const [, y, mo, d] = m.map(Number);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === mo - 1 &&
    probe.getUTCDate() === d
  );
}

// Monotonic integer id for a "YYYY-MM-DD" date: whole days since the Unix epoch. The
// unambiguous identifier remains the date string; this integer is the stable ID that
// persisted rounds key on and that a share token carries.
export function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

// Inverse of dayNumber: the "YYYY-MM-DD" date `n` whole days after the Unix epoch
// (pure UTC arithmetic — a dayNumber IS whole days since epoch). The archive (#55) uses
// it to turn a persisted round's dayNumber back into a shareable date URL. Round-trips
// with dayNumber for any date at UTC midnight: dateForDayNumber(dayNumber(d)) === d.
export function dateForDayNumber(n: number): string {
  const d = new Date(n * 86_400_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// The MONDAY that opens the calendar week of day number `n`, as a day number (Monday first
// — the week people say "this week" about). A day number is whole days since the Unix epoch
// at UTC midnight, so `getUTCDay` of that instant is the calendar weekday (0 for Sunday,
// which a Monday-first week puts six days in). DST-safe — no local time involved.
export function weekStart(n: number): number {
  const weekday = new Date(n * 86_400_000).getUTCDay();
  return n - ((weekday + 6) % 7);
}

// Offset (minutes, east-positive) of TIME_ZONE from UTC at `instant`, DST-correct.
function offsetMinutes(instant: Date): number {
  const p = zonedParts(instant);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asUtc - instant.getTime()) / 60_000;
}

// The UTC instant of local wall-clock (year, month, day, hour:00:00) in `timeZone`.
// DST-correct via a one-step offset refinement around the target instant.
function zonedTimeToUtc(year: number, month: number, day: number, hour: number): Date {
  const naive = Date.UTC(year, month - 1, day, hour, 0, 0);
  let offset = offsetMinutes(new Date(naive));
  let utc = naive - offset * 60_000;
  const refined = offsetMinutes(new Date(utc));
  if (refined !== offset) {
    offset = refined;
    utc = naive - offset * 60_000;
  }
  return new Date(utc);
}

// The next instant at which the active day flips (the next local RESET_HOUR:00).
export function nextResetAt(instant: Date): Date {
  // Before today's reset -> today's reset; at/after it -> tomorrow's: the ACTIVE date's.
  const [y, m, d] = activeDate(instant).split('-').map(Number);
  return zonedTimeToUtc(y, m, d, RESET_HOUR);
}

// Whole seconds from `instant` until the next active-day flip (>= 0). Used to set the
// CDN cache lifetime so cached puzzles expire exactly at the daily boundary.
export function secondsUntilNextReset(instant: Date): number {
  const ms = nextResetAt(instant).getTime() - instant.getTime();
  return Math.max(0, Math.floor(ms / 1000));
}
