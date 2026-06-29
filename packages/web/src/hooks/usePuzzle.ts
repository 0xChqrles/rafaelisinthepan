import { useEffect, useMemo, useState } from 'react';
import type { Puzzle } from '@whippin/shared';
import { puzzleUrl, todayUrl, resolveOverride, puzzleOutcome, type Today } from '../api';

// Loads the day's puzzle for the selected language. For normal play the BACKEND is
// the time source: the client asks it for "today's puzzle" (it never computes the
// date itself). The ?puzzle=<path|url> override loads a static file directly for
// local dev / testing. Idle (no fetch) until a language is chosen.
export default function usePuzzle(lang: string | null) {
  const [puzzle, setPuzzle] = useState<Puzzle | null>(null);
  // The server's stable day id for the loaded puzzle (null under an override or
  // before /today resolves). The front keys on this for persist (#7) / #9.
  const [dayNumber, setDayNumber] = useState<number | null>(null);
  const [error, setError] = useState<unknown | null>(null);
  const [noPuzzle, setNoPuzzle] = useState(false);

  // The ?puzzle= override is fixed for the page load.
  const override = useMemo(
    () => resolveOverride(window.location.search, import.meta.env.BASE_URL),
    [],
  );

  useEffect(() => {
    setPuzzle(null);
    setDayNumber(null);
    setError(null);
    setNoPuzzle(false);
    if (!lang) return undefined;

    let cancelled = false;
    (async () => {
      try {
        // Explicit override: a static puzzle file, no backend / no day number.
        if (override) {
          const r = await fetch(override);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const json = (await r.json()) as Puzzle;
          if (!cancelled) setPuzzle(json);
          return;
        }

        // Normal play: ask the backend for the day's puzzle + the server's day id.
        const [todayRes, puzzleRes] = await Promise.all([
          fetch(todayUrl()),
          fetch(puzzleUrl(lang)),
        ]);
        if (todayRes.ok) {
          const today = (await todayRes.json()) as Today;
          if (!cancelled) setDayNumber(today.dayNumber);
        }
        switch (puzzleOutcome(puzzleRes.status)) {
          case 'missing': // 404 -> graceful "NO PUZZLE TODAY", not an error screen.
            if (!cancelled) setNoPuzzle(true);
            return;
          case 'error':
            throw new Error(`HTTP ${puzzleRes.status}`);
          case 'puzzle': {
            const json = (await puzzleRes.json()) as Puzzle;
            if (!cancelled) setPuzzle(json);
          }
        }
      } catch (e) {
        if (!cancelled) setError(e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [lang, override]);

  // Language chosen but the puzzle hasn't resolved to a puzzle / error / no-puzzle yet.
  const loading = lang != null && puzzle == null && error == null && !noPuzzle;

  return { puzzle, dayNumber, error, loading, noPuzzle };
}
