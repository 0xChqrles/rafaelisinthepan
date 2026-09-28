// Launch-time tunables the front reads but never derives.
import type { LangCode } from './langs';

// The first game day the archive (#55) offers, PER LANGUAGE (#317: the languages are
// independent, and English starts later — one shared date would open its calendar on two
// months of empty days). It bounds the calendar's earliest month and the deep-link range:
// a `/<lang>/<date>` before its language's date (or after the client's active day) is
// treated as unknown. A 'YYYY-MM-DD' at UTC midnight, so it compares directly (string
// order) against other ISO date labels. English's is its planned launch day.
export const FIRST_PUZZLE_DATE: Record<LangCode, string> = {
  en: '2026-10-01',
  fr: '2026-08-01',
};
