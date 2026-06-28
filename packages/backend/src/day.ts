// The server is the authoritative time source. The "active day" — which puzzle is
// live — flips at 22:00 America/New_York (NYT-style: a date's puzzle is released the
// evening BEFORE that date). All conversions are DST-correct: the New-York wall clock
// is read via Intl with `timeZone`, never with a fixed UTC offset.

export const TIME_ZONE = 'America/New_York';
// Hour (local, 0-23) at which the active day rolls over to the NEXT calendar date.
export const RESET_HOUR = 22;

export interface DayOpts {
  timeZone?: string;
  resetHour?: number;
}

export interface ZonedParts {
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

// The active puzzle date ("YYYY-MM-DD") for `instant`. Before resetHour local it is
// today's NY date; at/after resetHour it is tomorrow's (the next date's puzzle is live).
export function activeDate(instant: Date, opts: DayOpts = {}): string {
  const timeZone = opts.timeZone ?? TIME_ZONE;
  const resetHour = opts.resetHour ?? RESET_HOUR;
  const p = zonedParts(instant, timeZone);
  return dateLabel(p.year, p.month, p.day, p.hour >= resetHour ? 1 : 0);
}

// Monotonic integer id for a "YYYY-MM-DD" date: whole days since the Unix epoch.
// The unambiguous identifier remains the date string; this is a convenience for the
// front (e.g. a "#NNN" badge). Routing (#6) may redefine it relative to a launch epoch.
export function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

// Offset (minutes, east-positive) of `timeZone` from UTC at `instant`, DST-correct.
function offsetMinutes(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asUtc - instant.getTime()) / 60_000;
}

// The UTC instant of local wall-clock (year, month, day, hour:00:00) in `timeZone`.
// DST-correct via a one-step offset refinement around the target instant.
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, 0, 0);
  let offset = offsetMinutes(new Date(naive), timeZone);
  let utc = naive - offset * 60_000;
  const refined = offsetMinutes(new Date(utc), timeZone);
  if (refined !== offset) {
    offset = refined;
    utc = naive - offset * 60_000;
  }
  return new Date(utc);
}

// The next instant at which the active day flips (the next local resetHour:00).
export function nextResetAt(instant: Date, opts: DayOpts = {}): Date {
  const timeZone = opts.timeZone ?? TIME_ZONE;
  const resetHour = opts.resetHour ?? RESET_HOUR;
  const p = zonedParts(instant, timeZone);
  // Before today's reset -> today's reset; at/after it -> tomorrow's.
  const target = dateLabel(p.year, p.month, p.day, p.hour >= resetHour ? 1 : 0);
  const [y, m, d] = target.split('-').map(Number);
  return zonedTimeToUtc(y, m, d, resetHour, timeZone);
}

// Whole seconds from `instant` until the next active-day flip (>= 0). Used to set the
// CDN cache lifetime so cached puzzles expire exactly at the daily boundary.
export function secondsUntilNextReset(instant: Date, opts: DayOpts = {}): number {
  const ms = nextResetAt(instant, opts).getTime() - instant.getTime();
  return Math.max(0, Math.floor(ms / 1000));
}
