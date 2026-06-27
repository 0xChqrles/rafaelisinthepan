// Daily puzzle schedule (Wordle-style).
//
// Each calendar day maps to one puzzle file PER LANGUAGE. Paths are relative to
// the served root (public/). To publish a day, add a "YYYY-MM-DD" entry with a
// path for each language you want playable that day; omit a language to leave it
// without a puzzle (the app shows "NO PUZZLE TODAY" for it).

export type PuzzleSchedule = Record<string, Record<string, string>>;

export const PUZZLE_SCHEDULE: PuzzleSchedule = {
  // NOTE: until more puzzles are generated, these days reuse the same two files
  // as placeholders — swap in dedicated files per day as they are produced.
  '2026-06-25': {
    fr: 'word/fr/vaincre_triomphe_gloire.json',
    en: 'word/en/slutty_dancing_kitchen.json',
  },
  '2026-06-26': {
    fr: 'word/fr/pleure_coeur_ville.json',
    en: 'word/en/slutty_dancing_kitchen.json',
  },
  '2026-06-27': {
    fr: 'word/fr/parfums_couleurs_sons.json',
    en: 'word/en/slutty_dancing_kitchen.json',
  },
};

// Local calendar date as "YYYY-MM-DD" — the key into PUZZLE_SCHEDULE.
export function todayKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// The scheduled puzzle path for a language on a given day, or null if none.
export function puzzlePathFor(lang: string, dateKey: string = todayKey()): string | null {
  return PUZZLE_SCHEDULE[dateKey]?.[lang] ?? null;
}
