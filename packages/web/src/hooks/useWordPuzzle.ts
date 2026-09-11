import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPuzzleCache } from './puzzleCache';
import { activeDate, dayNumber as dayNumberOf, type WordPuzzle } from '@whippin/shared';
import { wordPuzzleUrl, puzzleOutcome, parseWordPuzzle } from '../api';

// Word mode's twin of usePuzzle (#156): loads the day's #154 single-word artifact for
// the selected language. Same one-fetch, date-addressed protocol — the requested day is
// captured once (the archive's explicit past `date`, else the active 22:00-ET day at
// mount), the 404 -> noPuzzle path is shared, and `dayNumber` keys the word round the
// same way usePuzzle's keys the sentence round. Idle (no fetch) until a language is
// chosen.
// The last few PARSED artifacts, kept across mounts (`puzzleCache.ts` holds the two bounds
// and the safety argument): going back and forth between today's result and tomorrow's
// round no longer decompresses and parses megabytes on every arrival.
const wordCache = createPuzzleCache<WordPuzzle>();

export default function useWordPuzzle(lang: string | null, date?: string) {
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
  const [held, setHeld] = useState<{ key: string; puzzle: WordPuzzle } | null>(() => {
    const hit = key ? wordCache.get(key) : null;
    return hit && key ? { key, puzzle: hit } : null;
  });
  const puzzle = held && held.key === key ? held.puzzle : null;

  useEffect(() => {
    setError(null);
    setNoPuzzle(false);
    if (!lang || !key) return undefined;
    const hit = wordCache.get(key);
    if (hit) {
      setHeld({ key, puzzle: hit });
      return undefined;
    }

    let cancelled = false;
    (async () => {
      try {
        const answer = await wordCache.load(key, async () => {
          const res = await fetch(wordPuzzleUrl(lang, requestedDate));
          const outcome = puzzleOutcome(res.status);
          if (outcome === 'missing') return null;
          if (outcome === 'error') throw new Error(`HTTP ${res.status}`);
          return parseWordPuzzle(await res.json());
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
