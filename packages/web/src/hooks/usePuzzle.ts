import { useCallback, useEffect, useMemo, useState } from 'react';
import { activeDate, dayNumber as dayNumberOf, type Puzzle } from '@whippin/shared';
import { puzzleUrl, resolveOverride, puzzleOutcome, parsePuzzle } from '../api';

// Loads a day's puzzle for the selected language. Normal play (no `date`) fetches the
// client-computed active 22:00-ET game day (shared day.ts) — the served puzzle is BY
// CONSTRUCTION the day it is persisted under. The archive (#55) passes an explicit past
// `date` to replay it: same one fetch, same 404 -> noPuzzle path, only the requested day
// changes. The ?puzzle=<path|url> override loads a static file directly for local dev /
// testing. Idle (no fetch) until a language is chosen.
export default function usePuzzle(lang: string | null, date?: string) {
  const [puzzle, setPuzzle] = useState<Puzzle | null>(null);
  // The stable day id of the loaded puzzle — dayNumber(activeDate) computed at fetch
  // time, so it always matches the date the puzzle was requested for (null under an
  // override). The front keys on this for persist (#7) / #9.
  const [dayNumber, setDayNumber] = useState<number | null>(null);
  const [error, setError] = useState<unknown | null>(null);
  const [noPuzzle, setNoPuzzle] = useState(false);
  // Bumped by retry() to re-run the fetch after a transient/unexpected failure, so an
  // error never dead-ends in a blank/LOADING… screen (issue #14).
  const [reloadTick, setReloadTick] = useState(0);
  const retry = useCallback(() => setReloadTick((t) => t + 1), []);

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
          // parsePuzzle also throws on malformed JSON shape (not just bad JSON syntax).
          const json = parsePuzzle(await r.json());
          if (!cancelled) setPuzzle(json);
          return;
        }

        // ONE fetch for the requested day: the archive's explicit past `date`, else the
        // client-computed active day. The date names the puzzle, so the response can
        // never belong to a different day than the round key (dayNumber below) — the old
        // /today->puzzle pair and its 22:00-flip race are gone. A 404 covers both "no
        // puzzle published" and "date outside the server's window" — both are the
        // graceful NO PUZZLE state, not an error.
        const reqDate = date ?? activeDate(new Date());
        const day = dayNumberOf(reqDate);
        const puzzleRes = await fetch(puzzleUrl(lang, reqDate));
        const outcome = puzzleOutcome(puzzleRes.status);
        if (outcome === 'missing') {
          if (!cancelled) {
            setDayNumber(day);
            setNoPuzzle(true);
          }
          return;
        }
        if (outcome === 'error') throw new Error(`HTTP ${puzzleRes.status}`);
        // parsePuzzle catches malformed JSON / unexpected shape and turns it into
        // the error state instead of letting Game crash on a bad puzzle.
        const json = parsePuzzle(await puzzleRes.json());
        if (!cancelled) {
          setDayNumber(day);
          setPuzzle(json);
        }
      } catch (e) {
        if (!cancelled) setError(e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [lang, date, override, reloadTick]);

  // Language chosen but the puzzle hasn't resolved to a puzzle / error / no-puzzle yet.
  const loading = lang != null && puzzle == null && error == null && !noPuzzle;

  return { puzzle, dayNumber, error, loading, noPuzzle, retry };
}
