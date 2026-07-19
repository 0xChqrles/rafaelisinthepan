import { useCallback, useEffect, useMemo, useState } from 'react';
import { activeDate, dayNumber as dayNumberOf, type Puzzle } from '@whippin/shared';
import { puzzleUrl, puzzleOutcome, parsePuzzle } from '../api';

// Loads a day's puzzle for the selected language. Normal play (no `date`) fetches the
// client-computed active 22:00-ET game day (shared day.ts) — the served puzzle is BY
// CONSTRUCTION the day it is persisted under. The archive (#55) passes an explicit past
// `date` to replay it: same one fetch, same 404 -> noPuzzle path, only the requested day
// changes. Idle (no fetch) until a language is chosen.
export default function usePuzzle(lang: string | null, date?: string) {
  const [puzzle, setPuzzle] = useState<Puzzle | null>(null);
  const [error, setError] = useState<unknown | null>(null);
  const [noPuzzle, setNoPuzzle] = useState(false);
  // Bumped by retry() to re-run the fetch after a transient/unexpected failure, so an
  // error never dead-ends in a blank/LOADING… screen (issue #14).
  const [reloadTick, setReloadTick] = useState(0);
  const retry = useCallback(() => setReloadTick((t) => t + 1), []);

  // The requested game day, CAPTURED ONCE per `date` (NOT re-read on every render): the
  // archive's explicit past `date`, else the active 22:00-ET day sampled at mount. The
  // fetch below AND every consumer (header id, round key, share) read this SAME value, so
  // they can never disagree — e.g. an undated tab left open across the 22:00 flip keeps
  // showing the FETCHED day, not the newly-active one (the loaded puzzle does not silently
  // swap; a real navigation/reload is what moves to the new day).
  const requestedDate = useMemo(() => date ?? activeDate(new Date()), [date]);
  // Stable day id of the requested/loaded puzzle. Derived synchronously, so the header
  // shows the right id even while loading, and it always matches the fetched puzzle. The
  // round keys on this for persist (#7) / #9.
  const dayNumber = useMemo(() => dayNumberOf(requestedDate), [requestedDate]);

  useEffect(() => {
    setPuzzle(null);
    setError(null);
    setNoPuzzle(false);
    if (!lang) return undefined;

    let cancelled = false;
    (async () => {
      try {
        // ONE fetch for the requested day (captured above). The date names the puzzle, so
        // the response can never belong to a different day than `dayNumber` — the old
        // /today->puzzle pair and its 22:00-flip race are gone. A 404 covers both "no
        // puzzle published" and "date outside the server's window" — both are the
        // graceful NO PUZZLE state, not an error.
        const puzzleRes = await fetch(puzzleUrl(lang, requestedDate));
        const outcome = puzzleOutcome(puzzleRes.status);
        if (outcome === 'missing') {
          if (!cancelled) setNoPuzzle(true);
          return;
        }
        if (outcome === 'error') throw new Error(`HTTP ${puzzleRes.status}`);
        // parsePuzzle catches malformed JSON / unexpected shape and turns it into
        // the error state instead of letting Game crash on a bad puzzle.
        const json = parsePuzzle(await puzzleRes.json());
        if (!cancelled) setPuzzle(json);
      } catch (e) {
        if (!cancelled) setError(e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [lang, requestedDate, reloadTick]);

  // Language chosen but the puzzle hasn't resolved to a puzzle / error / no-puzzle yet.
  const loading = lang != null && puzzle == null && error == null && !noPuzzle;

  return { puzzle, dayNumber, error, loading, noPuzzle, retry };
}
