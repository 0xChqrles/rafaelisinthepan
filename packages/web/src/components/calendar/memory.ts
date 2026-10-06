import type { YearMonth } from '../../calendar';

// WHAT THE CALENDAR REMEMBERS in this tab (module state, never persisted — a reload forgets it
// all, which is the podium's `builtFor` rule):
//
//   BUILT    the months whose ARRIVAL has played, for the day and the account it played under:
//            a month shown again — turned back to, the screen reopened — is SETTLED from its first
//            frame. Nothing that has landed moves; a remount, a resize or a refetch never
//            replays it. A new day or another account starts the set again.
//   STAMPED  the days whose TODAY has dropped, per language: once per day per tab.
//   DRAWN    what each month was last drawn SAYING, day by day, as it is shown with data: the
//            month shown again with a day that says something else since (played here, or on
//            another device) plays that day's CHANGE — the reason a return to the archive after
//            a game shows what the player just did. Written as the change is shown, so a
//            change plays once, even left halfway.
//   LAST     the month last turned to, per language, today: the archive reopens on it (a day
//            played from September comes back to September). A new day opens on its own month.

// A day's reading as the calendar drew it: none, over (ended unsolved), a % (`p<pct>`), or
// solved.
export type DrawnCode = 'n' | 'o' | `p${number}` | 's';

const built = { scope: '', months: new Set<string>() };
const stamped = new Set<string>();
const drawn = new Map<string, Map<string, DrawnCode>>();
const last = { day: -1, months: new Map<string, YearMonth>() };

function builtSet(activeDay: number, accountId: string | null): Set<string> {
  const scope = `${activeDay}|${accountId ?? '-'}`;
  if (built.scope !== scope) {
    built.scope = scope;
    built.months = new Set();
  }
  return built.months;
}

export function isBuilt(activeDay: number, accountId: string | null, lang: string, month: string): boolean {
  return builtSet(activeDay, accountId).has(`${lang}|${month}`);
}

export function markBuilt(activeDay: number, accountId: string | null, lang: string, month: string): void {
  builtSet(activeDay, accountId).add(`${lang}|${month}`);
}

export function isStamped(lang: string, activeDay: number): boolean {
  return stamped.has(`${lang}|${activeDay}`);
}

export function markStamped(lang: string, activeDay: number): void {
  stamped.add(`${lang}|${activeDay}`);
}

export function drawnOf(accountId: string | null, lang: string, month: string): ReadonlyMap<string, DrawnCode> | undefined {
  return drawn.get(`${accountId ?? '-'}|${lang}|${month}`);
}

export function rememberDrawn(
  accountId: string | null,
  lang: string,
  month: string,
  codes: ReadonlyMap<string, DrawnCode>,
): void {
  drawn.set(`${accountId ?? '-'}|${lang}|${month}`, new Map(codes));
}

function lastMonths(activeDay: number): Map<string, YearMonth> {
  if (last.day !== activeDay) {
    last.day = activeDay;
    last.months = new Map();
  }
  return last.months;
}

export function lastMonth(lang: string, activeDay: number): YearMonth | undefined {
  return lastMonths(activeDay).get(lang);
}

export function rememberMonth(lang: string, activeDay: number, month: YearMonth): void {
  lastMonths(activeDay).set(lang, month);
}

// For tests: a fresh tab.
export function resetCalendarMemory(): void {
  built.scope = '';
  built.months = new Set();
  stamped.clear();
  drawn.clear();
  last.day = -1;
  last.months = new Map();
}
