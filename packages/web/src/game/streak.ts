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

// The longest consecutive run ANYWHERE in the set (the all-time best), independent of the
// active day. Empty set -> 0, a single day -> 1.
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
