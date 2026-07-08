// Launch-time tunables the front reads but never derives.

// The first game day the archive (#55) offers. It bounds the calendar's earliest
// month and the deep-link range: a `/<lang>/<date>` before this (or after the client's
// active day) is treated as unknown. A 'YYYY-MM-DD' at UTC midnight, so it compares
// directly (string order) against other ISO date labels.
export const FIRST_PUZZLE_DATE = '2026-07-01';
