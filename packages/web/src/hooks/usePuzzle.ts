import { useEffect, useState } from 'react';
import type { Puzzle } from '@rafaelisinthepan/shared';
import { puzzlePathFor, todayKey } from '../puzzleSchedule';

// Resolve which puzzle file to load for the selected language.
//   1. ?puzzle=<path>  -> explicit override (ignores the schedule), for testing.
//   2. ?date=<YYYY-MM-DD> overrides "today" when looking up the schedule.
//   3. otherwise: today's scheduled puzzle for `lang` (null if none scheduled).
// BASE_URL-aware so it survives a non-root deploy base; an explicit absolute
// URL (http/https) is used verbatim.
function resolvePuzzlePath(lang: string): string | null {
  const params = new URLSearchParams(window.location.search);
  const override = params.get('puzzle');
  const dateKey = params.get('date') ?? todayKey();
  const rel = override ?? puzzlePathFor(lang, dateKey);
  if (rel == null) return null;
  if (/^https?:\/\//.test(rel)) return rel;
  return `${import.meta.env.BASE_URL}${rel.replace(/^\/+/, '')}`;
}

// Loads the day's self-contained puzzle file for the selected language. Idle
// (no fetch) until a language is chosen.
export default function usePuzzle(lang: string | null) {
  const [puzzle, setPuzzle] = useState<Puzzle | null>(null);
  const [error, setError] = useState<unknown | null>(null);

  const path = lang ? resolvePuzzlePath(lang) : null;

  useEffect(() => {
    setPuzzle(null);
    setError(null);
    if (!path) return undefined;

    let cancelled = false;
    fetch(path)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json: Puzzle) => {
        if (!cancelled) setPuzzle(json);
      })
      .catch((e) => {
        if (!cancelled) setError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  // A puzzle is scheduled (path resolved) but not loaded yet and not errored.
  const loading = path != null && puzzle == null && error == null;
  // Language chosen but no puzzle scheduled for that language/day.
  const noPuzzle = lang != null && path == null;

  return { puzzle, error, loading, noPuzzle };
}
