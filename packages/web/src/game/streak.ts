// Streak derivation (issue #56). The persisted FACT is the per-language SET of solved
// game days (see gameStore's `solvedDays`); the streak counters are DERIVED from it here,
// never stored. That shape is deliberate: a future cross-device merge is a set UNION +
// recompute, not an impossible counter reconciliation — so these helpers stay correct
// under any union/ordering (the property the day-set exists for), and they defensively
// sort + dedupe their input so a raw union is a valid argument.

// Sort ascending + drop duplicates. A union of two valid sets may repeat a shared day;
// normalizing here makes the derivation order-independent and idempotent.
function normalize(days: number[]): number[] {
  return [...new Set(days)].sort((a, b) => a - b);
}

// Length of the consecutive run ending at the last solved day, but only while the streak
// is ALIVE: today is not yet required, so the last solved day may be today (activeDay) or
// yesterday (activeDay - 1). Once the last solve is older than yesterday the chain is
// broken and the current streak is 0. Empty set -> 0.
export function currentStreak(days: number[], activeDay: number): number {
  const sorted = normalize(days);
  if (sorted.length === 0) return 0;
  const last = sorted[sorted.length - 1];
  if (last < activeDay - 1) return 0; // chain broken — last solve is older than yesterday
  let run = 1;
  for (let i = sorted.length - 1; i > 0; i--) {
    if (sorted[i] - sorted[i - 1] === 1) run++;
    else break;
  }
  return run;
}

export interface StreakTransition {
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

export interface WeekView {
  // Whether the current week is "clean so far" — no elapsed day on/after the player's
  // first-ever solve is unsolved. Kept as a derived signal even though the celebration now
  // always shows the row (including a restarted streak after a missed day).
  clean: boolean;
  cells: WeekCell[]; // exactly 7, Monday..Sunday
}

// Monday-based weekday index (0 = Mon … 6 = Sun) of a dayNumber. dayNumber is whole days
// since the Unix epoch at UTC midnight, so getUTCDay of that instant is the calendar
// weekday; remap Sunday (0) to the Monday-first order. DST-safe — no local time involved.
function mondayIndex(dayNumber: number): number {
  const dow = new Date(dayNumber * 86_400_000).getUTCDay(); // 0 = Sun … 6 = Sat
  return (dow + 6) % 7; // 0 = Mon … 6 = Sun
}

// The current week (the Monday..Sunday that contains `activeDay`, #74) as 7 cells, plus
// whether it is "clean so far": every elapsed day (<= activeDay) that is on/after the
// player's FIRST-ever solve is solved. Days BEFORE the first solve are ignored — a
// mid-week newcomer still has a clean week (decided 2026-07-08). Pure over the day array,
// like the counters, so it stays correct under any future set union.
export function weekView(days: number[], activeDay: number): WeekView {
  const sorted = normalize(days);
  const solvedSet = new Set(sorted);
  const firstSolve = sorted.length > 0 ? sorted[0] : Infinity;
  const weekStart = activeDay - mondayIndex(activeDay); // this week's Monday
  let clean = true;
  const cells: WeekCell[] = [];
  for (let i = 0; i < 7; i++) {
    const d = weekStart + i;
    const solved = solvedSet.has(d);
    const isFuture = d > activeDay;
    cells.push({ dayNumber: d, solved, isToday: d === activeDay, isFuture });
    // A "miss" = an elapsed day, on/after the player's first solve, left unsolved.
    if (!isFuture && d >= firstSolve && !solved) clean = false;
  }
  return { clean, cells };
}

// The longest consecutive run ANYWHERE in the retained set, independent of the active day.
// Empty set -> 0, a single day -> 1. NOTE: this is "best within retained history", not a
// literally-forever best — solvedDays is bounded to the most recent MAX_SOLVED_DAYS per
// language (gameStore), by the issue's derive-only + capped-set design (persisting a real
// forever-best counter is exactly what that design refuses, since a counter can't merge
// across devices). The cap is far beyond any reachable streak for years, so in practice
// this IS the all-time best.
export function bestStreak(days: number[]): number {
  const sorted = normalize(days);
  if (sorted.length === 0) return 0;
  let best = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    run = sorted[i] - sorted[i - 1] === 1 ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}
