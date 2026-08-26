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
// same days. Re-exported here so every caller in this package keeps one import.
import { currentStreak } from '@whippin/shared';
export { currentStreak };

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
interface WeekCell {
  dayNumber: number;
  solved: boolean;
  isToday: boolean; // the active day (just solved on the solved screen)
  isFuture: boolean; // after the active day — not yet playable
}

interface WeekView {
  cells: WeekCell[]; // exactly 7, Monday..Sunday
}

// Monday-based weekday index (0 = Mon … 6 = Sun) of a dayNumber. dayNumber is whole days
// since the Unix epoch at UTC midnight, so getUTCDay of that instant is the calendar
// weekday; remap Sunday (0) to the Monday-first order. DST-safe — no local time involved.
function mondayIndex(dayNumber: number): number {
  const dow = new Date(dayNumber * 86_400_000).getUTCDay(); // 0 = Sun … 6 = Sat
  return (dow + 6) % 7; // 0 = Mon … 6 = Sun
}

// The current week (the Monday..Sunday that contains `activeDay`, #74) as 7 cells. Pure
// over the day array, like the counters, so it stays correct under any future set union.
export function weekView(days: number[], activeDay: number): WeekView {
  const solvedSet = new Set(days);
  const weekStart = activeDay - mondayIndex(activeDay); // this week's Monday
  const cells: WeekCell[] = [];
  for (let i = 0; i < 7; i++) {
    const d = weekStart + i;
    cells.push({
      dayNumber: d,
      solved: solvedSet.has(d),
      isToday: d === activeDay,
      isFuture: d > activeDay,
    });
  }
  return { cells };
}

