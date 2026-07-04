import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Puzzle } from '@whippin/shared';
import { puzzleUrl, todayUrl, resolveOverride, puzzleOutcome, parsePuzzle, type Today } from '../api';

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

        // Normal play (issue #42): /today is the FRESH version pointer AND the front door.
        // Fetch it first for the day id + the puzzle's content `version`. `version === null`
        // means there is no puzzle for this lang today -> NO PUZZLE, with no second fetch.
        // Otherwise request the content-addressed puzzle URL (/?lang=&v=<version>): a
        // republish changes the version -> a new URL -> a guaranteed cache miss, so the
        // corrected puzzle shows on a normal reload. The puzzle endpoint REQUIRES `v`, so
        // there is no canonical fallback — a failed /today is a real error (retryable, #14).
        //
        // The pair is not atomic: the 22:00 flip can land BETWEEN the two fetches, so the
        // puzzle the server resolves is the NEXT day's while `today` still describes the
        // previous one — persisting it under that dayNumber would key the round wrong. The
        // backend stamps the served day (X-Puzzle-Date); on a mismatch, re-run the whole
        // pair once with a fresh pointer. dayNumber/puzzle are only committed together,
        // from a matching pair.
        for (let attempt = 0; ; attempt += 1) {
          const todayRes = await fetch(todayUrl(lang));
          if (!todayRes.ok) throw new Error(`HTTP ${todayRes.status}`);
          const today = (await todayRes.json()) as Today;
          const version = today.version ?? null;
          if (version == null) {
            if (!cancelled) {
              setDayNumber(today.dayNumber);
              setNoPuzzle(true);
            }
            return;
          }
          if (cancelled) return;
          const puzzleRes = await fetch(puzzleUrl(lang, version));
          const outcome = puzzleOutcome(puzzleRes.status);
          if (outcome === 'missing') {
            // 404 (raced deletion) -> graceful "NO PUZZLE TODAY", not error.
            if (!cancelled) {
              setDayNumber(today.dayNumber);
              setNoPuzzle(true);
            }
            return;
          }
          if (outcome === 'error') throw new Error(`HTTP ${puzzleRes.status}`);
          const servedDate = puzzleRes.headers.get('x-puzzle-date');
          if (servedDate && servedDate !== today.date && attempt === 0) continue;
          // parsePuzzle catches malformed JSON / unexpected shape and turns it into
          // the error state instead of letting Game crash on a bad puzzle.
          const json = parsePuzzle(await puzzleRes.json());
          if (!cancelled) {
            setDayNumber(today.dayNumber);
            setPuzzle(json);
          }
          return;
        }
      } catch (e) {
        if (!cancelled) setError(e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [lang, override, reloadTick]);

  // Language chosen but the puzzle hasn't resolved to a puzzle / error / no-puzzle yet.
  const loading = lang != null && puzzle == null && error == null && !noPuzzle;

  return { puzzle, dayNumber, error, loading, noPuzzle, retry };
}
