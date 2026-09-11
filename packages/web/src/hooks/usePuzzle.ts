import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPuzzleCache } from './puzzleCache';
import { activeDate, dayNumber as dayNumberOf, type Puzzle } from '@whippin/shared';
import { puzzleUrl, puzzleOutcome, parsePuzzle } from '../api';

// Loads a day's puzzle for the selected language. Normal play (no `date`) fetches the
// client-computed active 22:00-ET game day (shared day.ts) — the served puzzle is BY
// CONSTRUCTION the day it is persisted under. The archive (#55) passes an explicit past
// `date` to replay it: same one fetch, same 404 -> noPuzzle path, only the requested day
// changes. Idle (no fetch) until a language is chosen.
// The last few PARSED artifacts, kept across mounts (`puzzleCache.ts` holds the two bounds
// and the safety argument): going back and forth between today's result and tomorrow's
// round no longer decompresses and parses megabytes on every arrival.
const sentenceCache = createPuzzleCache<Puzzle>();

export default function usePuzzle(lang: string | null, date?: string) {
  const [error, setError] = useState<unknown | null>(null);
  const [noPuzzle, setNoPuzzle] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const retry = useCallback(() => setReloadTick((t) => t + 1), []);

  const requestedDate = useMemo(() => date ?? activeDate(new Date()), [date]);
  const dayNumber = useMemo(() => dayNumberOf(requestedDate), [requestedDate]);
  const key = lang ? `${lang}:${requestedDate}` : null;

  // The puzzle is held WITH the key it answers, and a cached day is the first render's
  // own state: a revisit never shows the LOADING beat, and a day change never shows the
  // previous day's puzzle for the frame before the effect runs.
  const [held, setHeld] = useState<{ key: string; puzzle: Puzzle } | null>(() => {
    const hit = key ? sentenceCache.get(key) : null;
    return hit && key ? { key, puzzle: hit } : null;
  });
  const puzzle = held && held.key === key ? held.puzzle : null;

  useEffect(() => {
    setError(null);
    setNoPuzzle(false);
    if (!lang || !key) return undefined;
    const hit = sentenceCache.get(key);
    if (hit) {
      setHeld({ key, puzzle: hit });
      return undefined;
    }

    let cancelled = false;
    (async () => {
      try {
        const answer = await sentenceCache.load(key, async () => {
          const res = await fetch(puzzleUrl(lang, requestedDate));
          const outcome = puzzleOutcome(res.status);
          if (outcome === 'missing') return null;
          if (outcome === 'error') throw new Error(`HTTP ${res.status}`);
          return parsePuzzle(await res.json());
        });
        if (cancelled) return;
        if (answer === null) setNoPuzzle(true);
        else setHeld({ key, puzzle: answer });
      } catch (e) {
        if (!cancelled) setError(e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [lang, key, requestedDate, reloadTick]);

  const loading = lang != null && puzzle == null && error == null && !noPuzzle;

  return { puzzle, dayNumber, error, loading, noPuzzle, retry };
}
