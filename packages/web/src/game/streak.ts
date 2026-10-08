// Streak derivation (issue #56). The FACT is the per-language SET of solved game days —
// the SERVER's since #211 (`state/history.ts` holds it transiently; v15 dropped the
// persisted copy) — and the streak counters are DERIVED from it here, never stored. That
// shape is what made the collection portable across devices at all: reconciling it is a set
// UNION + recompute, not an impossible counter reconciliation. So these helpers stay correct
// under any union/ordering (the property the day-set exists for), and they defensively
// sort + dedupe their input so a raw union is a valid argument.

// `currentStreak` MOVED to @whippin/shared with #204: the erase confirmation names the
// streak the account being deleted is about to lose, so the SERVER derives one too, and two
// spellings would put a different number on that dialog than this screen shows over the
// same days.
import { currentStreak, weekStart } from '@whippin/shared';

interface StreakTransition {
  previous: number;
  next: number;
}

// The before/after values for the celebration triggered by `solvedDay`. The store has
// already inserted that day when the dialog mounts, so derive the previous state by removing
// it and anchor BOTH calculations to the solved game day (not a possibly-flipped wall clock).
export function streakTransition(days: number[], solvedDay: number): StreakTransition {
  return {
    previous: currentStreak(days.filter((day) => day !== solvedDay), solvedDay),
    next: currentStreak(days, solvedDay),
  };
}

// One cell of the weekly streak row (#74).
export interface WeekCell {
  dayNumber: number;
  solved: boolean;
  isToday: boolean; // the active day (just solved on the solved screen)
  isFuture: boolean; // after the active day — not yet playable
}

interface WeekView {
  cells: WeekCell[]; // exactly 7, Monday..Sunday
}

// The current week (the Monday..Sunday that contains `activeDay`, #74) as 7 cells. Pure
// over the day array, like the counters, so it stays correct under any future set union.
// A day credited AHEAD of its date (a preview solve, shared preview.ts) is no link until it
// arrives — the live streak (`currentStreak`) does not count it either.
export function weekView(days: number[], activeDay: number): WeekView {
  const solvedSet = new Set(days);
  const monday = weekStart(activeDay); // this week's Monday
  const cells: WeekCell[] = [];
  for (let i = 0; i < 7; i++) {
    const d = monday + i;
    cells.push({
      dayNumber: d,
      solved: solvedSet.has(d) && d <= activeDay,
      isToday: d === activeDay,
      isFuture: d > activeDay,
    });
  }
  return { cells };
}

// THE ACCOUNT'S WEEK (`/account`'s record, its chain): the week of the run the account's
// STREAK counts. That streak is the MAXIMUM of the per-language live streaks
// (`useAccountStats`, #204's aggregation), so the chain under it is the week of the language
// that holds the maximum — the links and the number tell ONE run, never a union of two
// languages' days that no streak counted. A tie goes to the earlier collection in the order
// given (the caller puts the screen's own language first).
export function recordWeek(collections: readonly (readonly number[])[], activeDay: number): WeekCell[] {
  let held: readonly number[] = [];
  let best = -1;
  for (const days of collections) {
    const run = currentStreak([...days], activeDay);
    if (run > best) {
      best = run;
      held = days;
    }
  }
  return weekView([...held], activeDay).cells;
}

// Monday-first narrow weekday initials, localized — the chain's own line, under the streak
// celebration's links and the account record's.
export function mondayNarrowLabels(lang: string): string[] {
  const fmt = new Intl.DateTimeFormat(lang, { weekday: 'narrow', timeZone: 'UTC' });
  return Array.from({ length: 7 }, (_, index) => fmt.format(new Date(Date.UTC(2024, 0, 1 + index))));
}
